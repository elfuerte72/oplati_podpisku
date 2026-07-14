import 'server-only';

import { Bot } from 'grammy';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

/**
 * grammY Bot singleton для webhook-mode.
 *
 * Используется ТОЛЬКО как HTTP-клиент Telegram API (`bot.api.sendMessage` и
 * аналогичные методы). `bot.start()` / `bot.run()` НЕ вызываются — диспатч
 * входящих updates делается руками в `apps/web/app/api/bot/route.ts`.
 *
 * Lazy-init: реальный Bot создаётся при первом обращении. Если
 * `TELEGRAM_BOT_TOKEN` не сконфигурирован — бросаем ошибку. Вызывающий код
 * (route.ts) проверяет наличие env заранее и не зовёт `getBot()` без токена.
 */

let _bot: Bot | undefined;
let _botUsername: string | undefined;
const log = childLogger('telegram-bot');

export function getBot(): Bot {
  if (_bot) return _bot;
  const token = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set; cannot initialize Telegram bot');
  }
  _bot = new Bot(token);
  log.debug({ event: 'telegram.bot.initialized' });
  return _bot;
}

/**
 * Username бота для deep-link `telegram.me/<username>?start=...` (привязка Telegram
 * к веб-сессии). Берётся через `getMe` и кэшируется на жизнь инстанса —
 * env-переменной с username нет, а токен на prod/preview принадлежит разным
 * ботам, так что getMe всегда отдаёт правильного.
 */
export async function getBotUsername(): Promise<string> {
  if (_botUsername) return _botUsername;
  const me = await getBot().api.getMe();
  _botUsername = me.username;
  log.debug({ event: 'telegram.bot.username_resolved' });
  return _botUsername;
}
