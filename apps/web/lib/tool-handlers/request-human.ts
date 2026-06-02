import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrderById, hasRecentOrderEvent } from '@oplati/db';
import { orderEvents } from '@oplati/db/schema';

import { childLogger } from '../logger.ts';
import { isWithinOperatorHours } from '../telegram/templates.ts';

/**
 * Tool `request_human` — заявка оператору.
 *
 * Текущее состояние (Спринт 1): реального handoff в forum-topics ещё нет.
 * Пишем event `handoff_requested` в `order_events` (append-only audit log).
 * Возвращаем AI флаг `withinBusinessHours`, чтобы он подобрал точный текст
 * ответа («свяжемся в течение часа» vs «ответим утром»).
 *
 * Защита от дублей: за последние 5 минут по тому же orderId не пишем второй
 * `handoff_requested` — пользователь может нажать «оператор» дважды подряд,
 * AI может вызвать tool на каждом сообщении. Без этого в Sentry будет шум,
 * а оператор получит дубль уведомления, когда поверх ляжет реальная очередь.
 *
 * Защита от подделки orderId (P2-14): если `orderId` есть, но не принадлежит
 * `userId` из контекста — игнорируем orderId (не пишем event), но саму заявку
 * не отвергаем; в логи кладём warning. Это страхует от случая, когда модель
 * галлюцинирует чужой UUID.
 */

const log = childLogger('tool.request_human');

const HANDOFF_EVENT_TYPE = 'handoff_requested';
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const SLA_HOURS = 1;

export type RequestHumanResult = {
  acknowledged: true;
  slaHours: number;
  withinBusinessHours: boolean;
  duplicate?: true;
};

export async function requestHuman(input: {
  orderId: string | null;
  reason: string;
  userId: string;
  conversationId: string;
}): Promise<RequestHumanResult> {
  const withinBusinessHours = isWithinOperatorHours();

  log.info({
    event: 'tool.request_human',
    orderId: input.orderId,
    userId: input.userId,
    conversationId: input.conversationId,
    reason: input.reason.slice(0, 200),
    withinBusinessHours,
  });

  if (!input.orderId) {
    log.info({
      event: 'handoff.requested',
      orderId: null,
      conversationId: input.conversationId,
      userId: input.userId,
      withinBusinessHours,
    });
    return { acknowledged: true, slaHours: SLA_HOURS, withinBusinessHours };
  }

  const db = getDb();
  const order = await getOrderById(db, input.orderId);
  if (!order || order.userId !== input.userId) {
    log.warn({
      event: 'tool.request_human.orderId_mismatch',
      orderId: input.orderId,
      userId: input.userId,
      conversationId: input.conversationId,
    });
    Sentry.captureMessage('request_human: orderId mismatch', {
      level: 'warning',
      tags: { source: 'tool.request_human' },
      extra: {
        orderId: input.orderId,
        userId: input.userId,
        conversationId: input.conversationId,
      },
    });
    log.info({
      event: 'handoff.requested',
      orderId: null,
      conversationId: input.conversationId,
      userId: input.userId,
      withinBusinessHours,
    });
    return { acknowledged: true, slaHours: SLA_HOURS, withinBusinessHours };
  }

  const isDuplicate = await hasRecentOrderEvent(db, {
    orderId: input.orderId,
    eventType: HANDOFF_EVENT_TYPE,
    withinMs: DEDUP_WINDOW_MS,
  });

  if (isDuplicate) {
    log.info({
      event: 'tool.request_human.duplicate',
      orderId: input.orderId,
      conversationId: input.conversationId,
    });
    return {
      acknowledged: true,
      slaHours: SLA_HOURS,
      withinBusinessHours,
      duplicate: true,
    };
  }

  await db.insert(orderEvents).values({
    orderId: input.orderId,
    actorType: 'ai',
    eventType: HANDOFF_EVENT_TYPE,
    fromStatus: null,
    toStatus: null,
    payload: {
      reason: input.reason,
      userId: input.userId,
      conversationId: input.conversationId,
      withinBusinessHours,
    },
  });

  log.info({
    event: 'handoff.requested',
    orderId: input.orderId,
    conversationId: input.conversationId,
    userId: input.userId,
    withinBusinessHours,
  });

  return { acknowledged: true, slaHours: SLA_HOURS, withinBusinessHours };
}
