import 'server-only';

import { Bot } from 'grammy';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { getBot } from './bot.ts';

/**
 * Отправитель операционных алёртов через ОТДЕЛЬНЫЙ alert-бот
 * (env `ALERT_BOT_TOKEN`; с 2026-07-26 это `@hermesbymxpk_bot` — бот
 * Hermes-агента владельца, чтобы алёрты приходили в тот же диалог, где он с
 * агентом общается).
 *
 * Зачем отдельный бот: наблюдатель не должен зависеть от наблюдаемого. Прод-бот
 * — клиентский (мешать операционку с клиентами нельзя); dev-бот перед каждым PR
 * становится тестовым стендом с webhook на preview-деплой, и его поведение
 * зависит от проверяемого кода — алёрт о падении не должен теряться из-за бага в
 * тестируемой фиче. Alert-бот только ОТПРАВЛЯЕТ (без webhook) и не участвует в
 * деплой-цикле.
 *
 * Fallback: `ALERT_BOT_TOKEN` не задан → шлём через прод-бот (`getBot()`), чтобы
 * не потерять алёрты при неполной конфигурации (поведение как раньше).
 * HTTP-клиент Telegram API, `bot.start()` не вызывается.
 */

let _alertBot: Bot | undefined;
const log = childLogger('telegram.alert-bot');

function getAlertBot(): Bot | null {
  if (_alertBot) return _alertBot;
  const token = serverEnv.ALERT_BOT_TOKEN;
  if (!token) return null;
  _alertBot = new Bot(token);
  log.debug({ event: 'telegram.alert_bot.initialized' });
  return _alertBot;
}

/**
 * Отправить алёрт в чат `chatId` через alert-бот (fallback — прод-бот).
 *
 * Это ПРЕЖНЯЯ схема доставки — личка `ALERT_TELEGRAM_CHAT_ID`; при заданной
 * ops-группе алёрты уходят ботом входа (`lib/alerts/streams.ts`), и этот
 * отправитель не участвует. `messageThreadId` — тема супергруппы, если чат
 * алёртов когда-нибудь окажется группой с темами; в личке не передавать.
 */
export async function sendAlert(
  chatId: string,
  text: string,
  opts: { messageThreadId?: number } = {},
): Promise<void> {
  const bot = getAlertBot() ?? getBot();
  if (opts.messageThreadId === undefined) {
    await bot.api.sendMessage(chatId, text);
    return;
  }
  await bot.api.sendMessage(chatId, text, { message_thread_id: opts.messageThreadId });
}
