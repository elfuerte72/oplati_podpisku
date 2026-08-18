import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { findReferralPayoutForPanel, getDb, transitionReferralPayout } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { isPayoutDecidable } from '@/lib/panel/payouts';

/**
 * POST /api/panel/partners/payout — решение по заявке на вывод (тикет 12, §6.4).
 *
 * ⚠️ Панель фиксирует ФАКТ, а не переводит деньги: `settlePayout` — mock и
 * нигде не вызывается, реальный перевод владелец делает руками. Кнопка «отметить
 * выплаченной» ставит статус, и не более.
 *
 * ⚠️ «Отклонить» нужна с первого дня: статус `rejected` не ставит сегодня ни
 * одна живая строка кода, а без него первая же заявка замораживает деньги
 * партнёра навсегда — сумма заявки вычитается из баланса, пока она не
 * отклонена.
 *
 * ⚠️ Суммы начислений отсюда НЕ правятся: ledger append-only, гашение делается
 * компенсирующей строкой `reversed`. Раздел доступен только владельцу — это
 * реальные деньги.
 *
 * ⚠️ Кто и по какой заявке принял решение, видно ТОЛЬКО в логе: колонки актора
 * у `referral_payouts` нет. Поэтому лог несёт `payoutId`, партнёра и сумму —
 * иначе восстановить «кто отметил эту заявку выплаченной» было бы нечем
 * (запись в `docs/BACKLOG.md`).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.partners');

const bodySchema = z.object({
  payoutId: z.string().uuid(),
  action: z.enum(['paid', 'reject']),
});

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('partners');
  if (!guard.ok) return panelGuardResponse(guard);

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const db = getDb();
  try {
    // Читаем ФАКТИЧЕСКИЙ статус: решение зависит от него, а не от предположения.
    // Заявка, застрявшая в `processing` (процесс умер между двумя переходами),
    // иначе не вынималась бы из панели ничем — а её сумма продолжала бы
    // вычитаться из баланса партнёра.
    const payout = await findReferralPayoutForPanel(db, body.payoutId);
    if (!payout) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    // Правило «по какой заявке можно решать» — общее с экраном: разъехавшись,
    // панель показывала бы кнопки там, где операция откажет (или наоборот).
    if (!isPayoutDecidable(payout.status)) return conflict(payout.status);

    if (body.action === 'reject') {
      // Отказ. Деньги возвращаются в баланс САМИ: формула баланса считает
      // заявки в статусах `requested|processing|paid` и отклонённые не
      // вычитает. Компенсирующая строка в ledger не нужна и была бы вредна —
      // журнал append-only, и лишнее начисление из него уже не вычистить.
      const res = await transitionReferralPayout(db, {
        payoutId: body.payoutId,
        from: payout.status,
        to: 'rejected',
      });
      if (!res.applied) return conflict(res.status);
      log.info({
        event: 'panel.payout.rejected',
        staffId: guard.actor.id,
        payoutId: payout.id,
        partnerUserId: payout.userId,
        amountUsdCents: payout.amountUsdCents,
        from: payout.status,
      });
      return Response.json({ ok: true, status: res.status });
    }

    // ⚠️ Заблокированному антифродом партнёру выплату не проводим. Кабинет не
    // даёт ему подать заявку, но поданная ДО блокировки живёт в `requested`, и
    // без гейта блокировка снималась бы одним кликом в панели. Отклонить —
    // можно: это как раз способ закрыть такую заявку.
    if (payout.suspended) {
      log.warn({ event: 'panel.payout.suspended_blocked', staffId: guard.actor.id });
      return Response.json({ ok: false, error: 'partner_suspended' }, { status: 409 });
    }

    // «Выплачено» — через `processing`. Машина статусов прямой переход не
    // разрешает намеренно: `processing` означает «деньги ушли, ждём
    // подтверждения», и он же страхует от повторного нажатия.
    if (payout.status === 'requested') {
      const toProcessing = await transitionReferralPayout(db, {
        payoutId: body.payoutId,
        from: 'requested',
        to: 'processing',
      });
      if (!toProcessing.applied) return conflict(toProcessing.status);
    }

    const toPaid = await transitionReferralPayout(db, {
      payoutId: body.payoutId,
      from: 'processing',
      to: 'paid',
    });
    if (!toPaid.applied) {
      // Заявка осталась в `processing`: деньги из баланса не вернулись, статус
      // не финальный. Из панели её теперь можно добить (мы читаем фактический
      // статус), но молчать о таком исходе нельзя.
      log.error({
        event: 'panel.payout.stuck_processing',
        staffId: guard.actor.id,
        payoutId: payout.id,
      });
      Sentry.captureMessage('Заявка на вывод застряла в processing', {
        level: 'error',
        tags: { source: 'panel.partners' },
        extra: { payoutId: body.payoutId },
      });
      return conflict(toPaid.status);
    }

    log.info({
      event: 'panel.payout.paid',
      staffId: guard.actor.id,
      payoutId: payout.id,
      partnerUserId: payout.userId,
      amountUsdCents: payout.amountUsdCents,
    });
    return Response.json({ ok: true, status: toPaid.status });
  } catch (err) {
    // `transitionReferralPayout` бросает на запрещённом переходе — это наша
    // ошибка кода, а не действие человека.
    log.error({
      event: 'panel.payout.failed',
      staffId: guard.actor.id,
      error: err instanceof Error ? err.message : 'unknown',
    });
    Sentry.captureException(err, { tags: { source: 'panel.partners' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}

/** Заявку уже кто-то обработал (или её нет): статус — то, что в базе сейчас. */
function conflict(status: string): Response {
  return Response.json({ ok: false, error: 'wrong_status', status }, { status: 409 });
}
