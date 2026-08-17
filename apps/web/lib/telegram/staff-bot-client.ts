import 'server-only';

import { Bot } from 'grammy';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { withFloodRetry } from './bot';

/**
 * HTTP-клиент бота ПЕРСОНАЛА (`@oplatishkaasupport_bot`, id 7992756364).
 *
 * Третий бот контура, и это осознанно:
 *   - клиентский `@oplatishkaa_bot` не годится — утечка клиентского токена не
 *     должна отдавать первый фактор входа персонала;
 *   - alert-бот остаётся на авариях инфраструктуры (наблюдатель не зависит от
 *     наблюдаемого).
 *
 * Он же доставляет уведомления менеджеру (тикет 11): сотрудник запускает его
 * при первом входе, значит доставка гарантирована — бот не может писать тому,
 * кто его не запускал.
 *
 * ⚠️ Fallback'а на другого бота здесь НЕТ намеренно: сообщение от чужого имени
 * в служебном канале хуже, чем отсутствие сообщения.
 */

let _bot: Bot | undefined;
const log = childLogger('telegram.staff-bot');

export function getStaffBot(): Bot | null {
  if (_bot) return _bot;
  const token = serverEnv.TELEGRAM_LOGIN_BOT_TOKEN;
  if (!token) return null;
  // `withFloodRetry` — как у клиентского бота: 429 от Telegram означает
  // «подожди N секунд», и без повтора уведомление менеджеру (тикет 11) молча
  // терялось бы, оставляя в логах один warning.
  _bot = withFloodRetry(new Bot(token));
  log.debug({ event: 'telegram.staff_bot.initialized' });
  return _bot;
}

/** Отправить сообщение сотруднику. Бросает — вызывающий решает, что с этим. */
export async function sendStaffMessage(chatId: number | string, text: string): Promise<void> {
  const bot = getStaffBot();
  if (!bot) {
    log.warn({ event: 'telegram.staff_bot.not_configured' });
    return;
  }
  await bot.api.sendMessage(chatId, text);
}
