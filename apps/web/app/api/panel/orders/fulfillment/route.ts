import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { OrderTransitionError, type OrderStatus } from '@oplati/types';
import { getDb, getOrderDetailForPanel, transitionOrderDetailed } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import {
  canCompleteManualFulfillment,
  canStartManualFulfillment,
  eventTypeFor,
  MANUAL_FULFILLMENT_ACTIONS,
  MANUAL_FULFILLMENT_COMMENT_MAX,
  MANUAL_FULFILLMENT_COMMENT_MIN,
  requiredStatusFor,
  targetStatusFor,
  type ManualFulfillmentAction,
} from '@/lib/panel/fulfillment';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { orderShortIdSchema } from '@/lib/panel/order-filters';
import { redactCardNumbers } from '@/lib/telegram/templates';

/**
 * POST /api/panel/orders/fulfillment — ручное исполнение заказа (тикет 06).
 *
 * Два шага: «беру в ручную выдачу» (`failed → in_fulfillment`, комментарий
 * обязателен) и «выдал» (существующий `in_fulfillment → completed`).
 *
 * ⚠️ Переход ТОЛЬКО через `transitionOrder*` (инвариант 4): статус и запись в
 * append-only `order_events` меняются одной транзакцией, и в событии остаётся,
 * кто это сделал и почему.
 *
 * Право `fulfillment` есть и у менеджера — намеренно (спека §4.3): надзор
 * работает лучше запрета, а каждое действие подписано именем сотрудника.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.fulfillment');
const dbLog = childLogger('db');

// Граница запроса (инвариант 5) живёт здесь, а не в `lib/panel/fulfillment.ts`:
// тот модуль читает и клиентский компонент, и zod уехал бы в браузер ради двух
// чисел. Само перечисление действий берётся оттуда — копии нет.
const bodySchema = z.object({
  shortId: orderShortIdSchema,
  action: z.enum(MANUAL_FULFILLMENT_ACTIONS),
  comment: z.string().optional(),
});

const commentSchema = z
  .string()
  .trim()
  .min(MANUAL_FULFILLMENT_COMMENT_MIN, 'нужно описать, что именно выдали')
  .max(MANUAL_FULFILLMENT_COMMENT_MAX);

export async function POST(req: Request): Promise<Response> {
  // Гейт Origin ПЕРВЫМ: чужой запрос не должен даже доходить до чтения сессии.
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

  // Комментарий обязателен ровно на первом шаге: он объясняет, ПОЧЕМУ заказ
  // выдали руками. На втором шаге его требовать незачем — причина уже записана.
  let comment: string | null = null;
  if (body.action === 'start') {
    const parsedComment = commentSchema.safeParse(body.comment ?? '');
    if (!parsedComment.success) {
      return Response.json({ ok: false, error: 'comment_required' }, { status: 400 });
    }
    // Маскируем номера карт: оператор пишет про ручной топап карты — ровно тот
    // случай, где PAN легко вписать. `order_events` append-only на уровне
    // триггера БД и не чистится retention'ом, то есть вписанное туда останется
    // навсегда. Та же функция, что защищает клиентские сообщения.
    comment = redactCardNumbers(parsedComment.data);
  }

  const detail = await getOrderDetailForPanel(getDb(), body.shortId);
  if (!detail) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  // Статус сверяем ДО перехода, чтобы человек получил понятный отказ, а не
  // `OrderTransitionError` из глубины. Гонку это не закрывает — её закрывает
  // сам `transitionOrderDetailed` (лок `FOR UPDATE` внутри транзакции).
  if (!isStatusReady(detail.order.status, detail.hasSucceededPayment, body.action)) {
    log.warn({
      event: 'panel.fulfillment.wrong_status',
      staffId: guard.actor.id,
      status: detail.order.status,
      action: body.action,
    });
    // Отдельная причина, когда дело не в статусе, а в деньгах: «выдать
    // вручную» заказ, по которому оплата не пришла, нельзя вообще.
    const error =
      body.action === 'start' && detail.order.status === 'failed' && !detail.hasSucceededPayment
        ? 'not_paid'
        : 'wrong_status';
    return Response.json(
      { ok: false, error, expected: requiredStatusFor(body.action) },
      { status: 409 },
    );
  }

  try {
    const res = await transitionOrderDetailed(
      getDb(),
      {
        orderId: detail.order.id,
        toStatus: targetStatusFor(body.action),
        actorType: 'operator',
        actorId: guard.actor.id,
        eventType: eventTypeFor(body.action),
        payload: comment === null ? { manual: true } : { manual: true, comment },
      },
      dbLog,
    );

    log.info({
      event: 'panel.fulfillment.done',
      staffId: guard.actor.id,
      orderId: detail.order.id,
      action: body.action,
      transitioned: res.transitioned,
    });

    return Response.json({ ok: true, status: res.order.status, transitioned: res.transitioned });
  } catch (err) {
    if (err instanceof OrderTransitionError) {
      // Заказ увели параллельно (второй оператор, крон): статус уже другой.
      log.warn({ event: 'panel.fulfillment.rejected', staffId: guard.actor.id, err });
      return Response.json({ ok: false, error: 'wrong_status' }, { status: 409 });
    }
    // Логируем УЗКО: у ошибки postgres-js перечисляемые `detail`/`where` несут
    // «Failing row contains (…)» — то есть всю строку события вместе с
    // комментарием оператора.
    log.error({
      event: 'panel.fulfillment.failed',
      staffId: guard.actor.id,
      error: err instanceof Error ? err.message : 'unknown',
    });
    Sentry.captureException(err, { tags: { source: 'panel.fulfillment' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}

function isStatusReady(
  status: OrderStatus,
  hasSucceededPayment: boolean,
  action: ManualFulfillmentAction,
): boolean {
  return action === 'start'
    ? canStartManualFulfillment(status, hasSucceededPayment)
    : canCompleteManualFulfillment(status);
}
