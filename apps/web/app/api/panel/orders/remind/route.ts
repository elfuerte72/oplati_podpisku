import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import {
  appendOrderEvent,
  claimPaymentReminder,
  getDb,
  listPendingOrdersForPanel,
  PAYMENT_REMINDER_FAILED_EVENT,
} from '@oplati/db';
import { paymentGateway } from '@oplati/types';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { orderShortIdSchema } from '@/lib/panel/order-filters';
import {
  PAYMENT_REMINDER_COOLDOWN_MS,
  buildPaymentReminderText,
  remindBlockReason,
  remindGateInput,
} from '@/lib/panel/remind';
import { buyerFeePercentFor } from '@/lib/payments/gateway';
import { getBot } from '@/lib/telegram/bot';
import { buildBuyerFeeLine } from '@/lib/telegram/templates';

/**
 * POST /api/panel/orders/remind — напомнить клиенту об оплате (тикет 07).
 *
 * ⚠️ Операция НИЧЕГО не создаёт и не двигает: она отправляет в Telegram ссылку
 * СУЩЕСТВУЮЩЕГО живого счёта. Ни нового инвойса, ни продления срока, ни смены
 * статуса заказа — иначе кнопка в панели стала бы вторым способом выпускать
 * денежные документы мимо `payments/create` с его гейтами (контакты, потолок
 * суммы, фиксация цены).
 *
 * ⚠️ Суточное окно ЗАНИМАЕТСЯ до отправки атомарным `claimPaymentReminder`.
 * Схема «прочитали последнюю отметку → отправили → записали» атомарной не
 * является: две вкладки проходят гейт одновременно, и клиент получает два
 * одинаковых платёжных документа от официального бота. Цена такого порядка —
 * сорванная отправка съедает окно; она не молчит: рядом пишется событие «не
 * доставлено», и экран показывает его вместо времени отправки.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.remind');

const bodySchema = z.object({ shortId: orderShortIdSchema });

/** Ссылка уходит живому человеку — проверяем её как границу, а не «есть/нет». */
const paymentUrlSchema = z.string().url().startsWith('https://');

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('pending');
  if (!guard.ok) return panelGuardResponse(guard);

  let shortId: string;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    shortId = parsed.data.shortId;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const db = getDb();
  // Читаем ТОТ ЖЕ источник, что и экран, сузив его до одного заказа: своя
  // выборка «по номеру» означала бы второе место, где решается, живой ли счёт,
  // — и однажды они разойдутся, а цена расхождения тут это ссылка на мёртвый
  // счёт живому клиенту. Перебирать страницу нельзя: за её потолком операция
  // отдавала бы «заказ не найден» вместо отправки.
  const { items } = await listPendingOrdersForPanel(db, { shortId, limit: 1 });
  const order = items[0];
  if (!order) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const now = new Date();
  const blocked = remindBlockReason(remindGateInput(order, now));
  if (blocked) {
    log.warn({ event: 'panel.remind.blocked', staffId: guard.actor.id, reason: blocked });
    return Response.json({ ok: false, error: blocked }, { status: 409 });
  }

  const paymentUrl = paymentUrlSchema.safeParse(order.invoice?.paymentUrl);
  if (!paymentUrl.success) {
    // Снимок инвойса испорчен. Отправлять клиенту мусор нельзя, а молчать
    // нельзя тем более: такой заказ виден на экране как готовый к напоминанию.
    log.error({ event: 'panel.remind.bad_payment_url', orderId: order.orderId });
    Sentry.captureMessage('Панель: в снимке инвойса нет пригодной ссылки на оплату', {
      level: 'error',
      tags: { source: 'panel.remind' },
      extra: { orderId: order.orderId },
    });
    return Response.json({ ok: false, error: 'invoice_expired' }, { status: 409 });
  }

  const telegramId = order.client.telegramId;
  if (!telegramId) return Response.json({ ok: false, error: 'no_telegram' }, { status: 409 });

  // Бот берётся ДО отправки и в своей ветке: пропавший токен — наша авария
  // конфигурации, и выдавать её за «клиент заблокировал бота» нельзя. Иначе
  // менеджер увидит отказ клиента по каждому заказу подряд и пойдёт разбираться
  // не туда.
  let bot: ReturnType<typeof getBot>;
  try {
    bot = getBot();
  } catch (err) {
    log.error({ event: 'panel.remind.bot_unavailable', err });
    Sentry.captureException(err, { tags: { source: 'panel.remind', step: 'bot' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  // Окно занимаем ДО отправки — см. заголовок модуля.
  const claimed = await claimPaymentReminder(db, {
    orderId: order.orderId,
    cooldownMs: PAYMENT_REMINDER_COOLDOWN_MS,
    actorId: guard.actor.id,
  });
  if (!claimed) {
    log.warn({ event: 'panel.remind.claim_lost', staffId: guard.actor.id, orderId: order.orderId });
    return Response.json({ ok: false, error: 'too_soon' }, { status: 409 });
  }

  try {
    await bot.api.sendMessage(
      telegramId,
      buildPaymentReminderText({
        shortId: order.shortId,
        amountRubKopecks: order.amountRubKopecks,
        paymentUrl: paymentUrl.data,
        expiresAt: order.invoice?.expiresAt ?? null,
        // Надбавку платёжной системы называем ТУ ЖЕ, что и первое сообщение со
        // ссылкой: без неё напоминание обещает 11 680 ₽ там, где страница
        // оплаты попросит около 12 381 ₽ (надбавка покупателя Freekassa 6%).
        // Процент берётся у шлюза ЭТОГО счёта, а не у текущего основного.
        feeNote: buyerFeeLineFor(order.invoice?.provider, order.amountRubKopecks),
        now,
      }),
      { link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    // Клиент заблокировал бота — самая частая причина. Окно уже занято, вернуть
    // его нечем (журнал append-only), поэтому пишем ФАКТ недоставки: без него
    // экран показывал бы «напоминали в 14:20» тому, кто ничего не получил.
    log.warn({ event: 'panel.remind.send_failed', orderId: order.orderId, err });
    try {
      await appendOrderEvent(db, {
        orderId: order.orderId,
        eventType: PAYMENT_REMINDER_FAILED_EVENT,
        actorType: 'operator',
        actorId: guard.actor.id,
        payload: { reason: 'telegram_rejected' },
      });
    } catch (markErr) {
      log.error({ event: 'panel.remind.fail_mark_lost', orderId: order.orderId, err: markErr });
      Sentry.captureException(markErr, { tags: { source: 'panel.remind', step: 'fail_mark' } });
    }
    return Response.json({ ok: false, error: 'send_failed' }, { status: 502 });
  }

  log.info({ event: 'panel.remind.sent', staffId: guard.actor.id, orderId: order.orderId });
  return Response.json({ ok: true });
}

/**
 * Строка про надбавку платёжной системы для сообщения клиенту. `null` — шлюз
 * счёта надбавку не берёт либо провайдер незнакомый (тогда молчим, а не
 * выдумываем процент).
 */
function buyerFeeLineFor(provider: string | undefined, amountKopecks: number | null): string | null {
  const parsed = provider ? paymentGateway.safeParse(provider) : null;
  if (!parsed?.success) return null;
  const percent = buyerFeePercentFor(parsed.data);
  return buildBuyerFeeLine(percent, amountKopecks ?? undefined);
}
