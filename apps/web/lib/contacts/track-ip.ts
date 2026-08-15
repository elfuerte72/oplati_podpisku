import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, touchUserLastSeenIp } from '@oplati/db';

import { getClientIp } from '../client-ip.ts';
import { childLogger } from '../logger.ts';

/**
 * Запомнить последний живой IP клиента (антифрод-трек, тикет 01).
 *
 * Зовётся из роутов, где есть живой запрос клиента и известен пользователь:
 * кабинет, propose, confirm, чат. Адрес затем уходит Freekassa как IP
 * плательщика вместо адреса нашего VPS — главная причина антифрод-холдов.
 *
 * Best-effort: сбой записи не должен ронять основной путь (заказ важнее
 * телеметрии адреса), но и не глотается молча — лог + Sentry. `unknown`
 * (запрос без валидного заголовка) не пишем: мусор в поле, которое уходит
 * провайдеру, хуже отсутствия значения.
 */

const log = childLogger('contacts.track-ip');

export async function rememberClientIp(req: Request, userId: string): Promise<void> {
  try {
    const ip = getClientIp(req);
    if (ip === 'unknown') return;
    await touchUserLastSeenIp(getDb(), { userId, ip });
  } catch (err) {
    log.error({ event: 'contacts.track_ip_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'contacts.track-ip' } });
  }
}
