import 'server-only';

import { getDb } from '@oplati/db';
import { orderEvents } from '@oplati/db/schema';

import { childLogger } from '../logger.ts';

/**
 * Tool `request_human` — заглушка под будущий milestone handoff.
 *
 * Сейчас пишет запись в `order_events` (event_type='human_requested', actor_type='ai')
 * и возвращает acknowledged=true; AI озвучивает пользователю «оператор подключится
 * в течение часа». Реальный handoff (forum-topics в TG) — отдельная ветка.
 *
 * Если orderId не задан — пишем pseudo-event в системный заказ нельзя (FK NOT NULL).
 * Поэтому без orderId — просто логируем + Sentry, в БД ничего не пишем.
 */

const log = childLogger('tool.request_human');

export async function requestHuman(input: {
  orderId: string | null;
  reason: string;
  userId: string;
  conversationId: string;
}): Promise<{ acknowledged: true }> {
  log.info({
    event: 'tool.request_human',
    orderId: input.orderId,
    userId: input.userId,
    conversationId: input.conversationId,
    reason: input.reason.slice(0, 200),
  });

  if (input.orderId) {
    const db = getDb();
    await db.insert(orderEvents).values({
      orderId: input.orderId,
      actorType: 'ai',
      eventType: 'human_requested',
      fromStatus: null,
      toStatus: null,
      payload: {
        reason: input.reason,
        userId: input.userId,
        conversationId: input.conversationId,
      },
    });
  }

  return { acknowledged: true };
}
