import 'server-only';

import { randomUUID } from 'node:crypto';

import { after } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import {
  ANALYTICS_EVENTS,
  sanitizeAnalyticsProps,
  type AnalyticsEventName,
  type AnalyticsProps,
} from '@oplati/types';
import { getDb, insertAnalyticsEvents, type AnalyticsEventInsert } from '@oplati/db';

import { childLogger } from '@/lib/logger';

/**
 * Запись поведенческих событий с сервера.
 *
 * ГЛАВНАЯ ГАРАНТИЯ: этот модуль не может уронить вызывающий код. Аналитика —
 * наблюдатель; потерянное событие стоит несоизмеримо меньше, чем сорванный
 * заказ или неотвеченный апдейт Telegram. Поэтому:
 *   - запись уходит в `after()` (после отправки ответа, вне критического пути);
 *   - любая ошибка гасится здесь: лог + Sentry, наружу ничего не летит;
 *   - вызов НИКОГДА не оборачивается в транзакцию денежного пути.
 *
 * Денежные вехи (оплата, выпуск карты, счёт) сюда не пишутся вообще — они уже
 * в `order_events`, и дублировать их телеметрией значит завести вторую правду
 * о деньгах. См. `ANALYTICS_MILESTONES` в @oplati/types.
 */

const log = childLogger('analytics');

export type TrackIdentity = {
  webSessionId?: string | null;
  telegramId?: string | null;
};

export type TrackInput = TrackIdentity & {
  name: AnalyticsEventName;
  props?: AnalyticsProps;
  orderId?: string | null;
  /** Момент события, если он отличается от «сейчас». */
  occurredAt?: Date;
  /**
   * Ключ идемпотентности. Задавать, когда один и тот же факт может прийти
   * дважды (ретрай апдейта Telegram) — иначе генерируется случайный.
   */
  eventKey?: string;
};

function toInsert(input: TrackInput, origin: 'client' | 'server'): AnalyticsEventInsert {
  const spec = ANALYTICS_EVENTS[input.name];
  return {
    eventKey: input.eventKey ?? randomUUID(),
    name: input.name,
    channel: spec.channel,
    origin,
    webSessionId: input.webSessionId ?? null,
    telegramId: input.telegramId ?? null,
    orderId: input.orderId ?? null,
    props: sanitizeAnalyticsProps(input.props),
    occurredAt: input.occurredAt ?? new Date(),
  };
}

/**
 * Записать событие с сервера. Возврата не ждём и ошибок не бросаем.
 *
 * Вызывается из обработчиков бота и из роутов — то есть из живого продуктового
 * пути. Именно поэтому `void`, а не `Promise`: `await` на телеметрии добавил бы
 * ей право задерживать ответ клиенту.
 */
export function trackServer(input: TrackInput): void {
  try {
    after(async () => {
      await writeEvents([toInsert(input, 'server')]);
    });
  } catch (err) {
    // `after()` вне запроса (крон, скрипт) бросает — пишем синхронно, но всё
    // так же не наружу.
    void writeEvents([toInsert(input, 'server')]).catch(() => undefined);
    log.debug({ event: 'analytics.after_unavailable', err });
  }
}

/**
 * Запись пачки уже провалидированных событий. Единственная точка, которая
 * ходит в БД, и единственная, где гасятся ошибки.
 */
export async function writeEvents(events: AnalyticsEventInsert[]): Promise<number> {
  if (events.length === 0) return 0;
  try {
    const inserted = await insertAnalyticsEvents(getDb(), events);
    log.debug({ event: 'analytics.written', count: inserted, received: events.length });
    return inserted;
  } catch (err) {
    // Аналитика недоступна — продукт продолжает работать. Молча глотать нельзя
    // (конвенция «never swallow errors»), но и отдавать наружу тоже: вызывающий
    // код не должен уметь сломаться из-за телеметрии.
    log.error({ event: 'analytics.write_failed', count: events.length, err });
    Sentry.captureException(err, { tags: { source: 'analytics.write' } });
    return 0;
  }
}
