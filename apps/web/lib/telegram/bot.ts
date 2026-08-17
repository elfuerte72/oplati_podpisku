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

/**
 * Максимум ПОВТОРОВ после 429 (сверх исходной попытки).
 * Держим маленьким: роут бота живёт 90 с, а ожидание тут синхронное.
 */
const FLOOD_MAX_RETRIES = 2;
/**
 * Ждём не дольше этого. Флуд-контроль на один чат обычно просит 1–3 секунды —
 * это нормальный всплеск, его переживаем. Большое значение означает серьёзное
 * ограничение, и ждать его в обработчике вебхука неправильно: лучше отдать
 * ошибку наверх, чем занять слот и не ответить Telegram вовсе.
 */
const FLOOD_MAX_WAIT_SECONDS = 5;

export function withFloodRetry(bot: Bot): Bot {
  bot.api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await prev(method, payload, signal);
      if (res.ok) return res;

      // 429 у Telegram — не ошибка запроса, а «подожди `retry_after` секунд».
      // Без повтора сообщение молча терялось: клиент не получал ни ссылку на
      // оплату, ни реквизиты карты, а в логах оставался один warning.
      const retryAfter = res.parameters?.retry_after;
      if (res.error_code !== 429 || retryAfter === undefined) return res;
      if (attempt >= FLOOD_MAX_RETRIES || retryAfter > FLOOD_MAX_WAIT_SECONDS) {
        log.warn({ event: 'telegram.flood.giving_up', method, retryAfter, attempt });
        return res;
      }
      log.warn({ event: 'telegram.flood.retrying', method, retryAfter, attempt });
      // +250 мс: у Telegram и у нас часы разные, впритык можно получить 429 снова.
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 250));
    }
  });
  return bot;
}

/**
 * Числовой id бота — префикс токена до двоеточия. Не секрет (виден в любой
 * ссылке `t.me`), но однозначно разделяет прод и dev в ОБЩЕМ Redis: без него
 * два контура гасили бы ключи друг друга (дедуп апдейтов, дедуп подсказок).
 *
 * Живёт здесь, а не рядом с потребителем: потребителей уже двое
 * (`app/api/bot/route.ts` и `silent-hint.ts`), а копия формата ключа — зеркало,
 * которое разъезжается молча.
 */
export function botIdFromToken(token: string | undefined): string {
  const id = token?.split(':')[0];
  return id && /^\d+$/.test(id) ? id : 'unknown';
}

export function getBot(): Bot {
  if (_bot) return _bot;
  const token = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set; cannot initialize Telegram bot');
  }
  _bot = withFloodRetry(new Bot(token));
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
