import 'server-only';

import { validateInitData } from '@/lib/telegram/init-data';
import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

const log = childLogger('analytics-identity');

/**
 * `telegram_id` для события из Mini App — ТОЛЬКО из подписанной `initData`.
 *
 * Класть идентификатор в тело запроса нельзя ни при каких условиях: тогда любой
 * дописал бы события в чужой путь, а путь клиента — это то, по чему мы потом
 * разбираем его жалобу. Подпись проверяется на каждом запросе, как и в
 * `/api/cabinet` (lib/cabinet/auth.ts).
 *
 * Невалидная подпись — не ошибка запроса, а просто «личность не установлена»:
 * телеметрия не тот повод, чтобы отвечать 401 фоновому запросу браузера.
 */
export function readTelegramIdFromInitData(initData: string | null): string | null {
  if (!initData) return null;

  const botToken = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;

  const result = validateInitData(initData, botToken);
  if (!result.ok) {
    log.debug({ event: 'analytics.initdata_rejected', reason: result.reason });
    return null;
  }

  return String(result.user.id);
}
