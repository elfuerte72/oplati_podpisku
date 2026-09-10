import * as Sentry from '@sentry/nextjs';
import { after } from 'next/server';
import { z } from 'zod';

import {
  appendOrderEvent,
  BONUS_RELEASED_EVENT,
  getDb,
  getOrderDetailForPanel,
  releaseBonusReservation,
} from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { invalidateMenuCounts } from '@/lib/panel/menu-counts';
import { orderShortIdSchema } from '@/lib/panel/order-filters';
import { getBot } from '@/lib/telegram/bot';

/**
 * POST /api/panel/orders/bonus-refund — вернуть клиенту списанные баллы
 * (трек referral-balance-spend, тикет 08).
 *
 * Возврат при `failed` — РЕШЕНИЕ ЧЕЛОВЕКА, а не правило. `failed` не синоним
 * «деньги вернули»: туда же попадают недоплата и отвергнутый счёт, а дальше
 * оператор решает — вернуть деньги или довести выдачу вручную
 * (`failed → in_fulfillment → completed`). Судьба баллов — то же решение, и
 * принимает его тот же человек.
 *
 * Автовозврат отсюда был бы единственным путём к ОТРИЦАТЕЛЬНОМУ балансу
 * клиента: ручная выдача списала бы баллы повторно, а клиент успел бы потратить
 * их на другом заказе.
 *
 * Право — `fulfillment` (оператор и владелец): разделять решение о деньгах и
 * решение о баллах между двумя людьми значит потерять его посередине.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.bonus-refund');
const dbLog = childLogger('db');

const bodySchema = z.object({ shortId: orderShortIdSchema });

export async function POST(req: Request): Promise<Response> {
  // Гейт Origin ПЕРВЫМ: `sameSite=lax` между `www` и `admin` не защищает —
  // это один site.
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('fulfillment');
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
  const detail = await getOrderDetailForPanel(db, body.shortId);
  if (!detail) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  // Понятный отказ вместо 500 там, где возвращать нечего: заказ без списания —
  // обычное дело, и кнопку могли нажать по устаревшему экрану.
  if (!detail.bonus) {
    log.info({ event: 'panel.bonus_refund.nothing', staffId: guard.actor.id, shortId: body.shortId });
    return Response.json({ ok: false, error: 'no_bonus' }, { status: 409 });
  }
  if (detail.order.status !== 'failed') {
    log.warn({
      event: 'panel.bonus_refund.wrong_status',
      staffId: guard.actor.id,
      status: detail.order.status,
    });
    return Response.json({ ok: false, error: 'wrong_status' }, { status: 409 });
  }

  try {
    // Возврат и событие — В ОДНОЙ транзакции: без неё сбой записи события
    // оставлял бы возврат без автора в append-only журнале, то есть без ответа
    // на вопрос «кто вернул деньги клиенту».
    const released = await db.transaction(async (tx) => {
      const res = await releaseBonusReservation(
        tx,
        { orderId: detail.order.id, releasedBy: guard.actor.id },
        dbLog,
      );
      if (!res.applied || !res.redemption) return null;
      await appendOrderEvent(tx, {
        orderId: detail.order.id,
        eventType: BONUS_RELEASED_EVENT,
        actorType: 'operator',
        actorId: guard.actor.id,
        payload: {
          spendUsdCents: res.redemption.amountUsdCents,
          discountKopecks: res.redemption.discountKopecks,
          reason: 'operator_refund',
        },
      });
      return res.redemption;
    });

    if (!released) {
      // Условный UPDATE не нашёл живой строки — баллы уже вернули (второе
      // нажатие, второй оператор). Это не ошибка: состояние ровно то, которого
      // человек добивался.
      log.info({
        event: 'panel.bonus_refund.already',
        staffId: guard.actor.id,
        orderId: detail.order.id,
      });
      return Response.json({ ok: true, alreadyReleased: true });
    }

    log.info({
      event: 'panel.bonus_refund.done',
      staffId: guard.actor.id,
      orderId: detail.order.id,
      userId: released.userId,
      amountUsdCents: released.amountUsdCents,
    });
    // Строка баллов видна на трёх экранах панели — счётчики и таблицы обязаны
    // догнать её без перезагрузки.
    invalidateMenuCounts('holds');

    // Сообщение клиенту — best-effort и ПОСЛЕ ответа: строка в БД это факт,
    // доставка — нет, и её сбой не должен откатывать возврат.
    const telegramId = detail.client.telegramId;
    if (telegramId) {
      after(() => notifyClientAboutRefund(telegramId, released.discountKopecks));
    }

    return Response.json({ ok: true, alreadyReleased: false });
  } catch (err) {
    log.error({
      event: 'panel.bonus_refund.failed',
      staffId: guard.actor.id,
      orderId: detail.order.id,
      error: err instanceof Error ? err.message : 'unknown',
    });
    Sentry.captureException(err, { tags: { source: 'panel.bonus-refund' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}

/** Никогда не бросает: возврат уже состоялся, доставка его не отменяет. */
async function notifyClientAboutRefund(
  telegramId: string,
  discountKopecks: number,
): Promise<void> {
  try {
    await getBot().api.sendMessage(
      telegramId,
      `Вернули баллы на баланс: ${Math.round(discountKopecks / 100)} ₽. ` +
        'Списать их можно при оплате следующего заказа.',
    );
  } catch (err) {
    log.warn({ event: 'panel.bonus_refund.notify_failed', err });
  }
}
