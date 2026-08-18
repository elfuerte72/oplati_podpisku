import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { findStaffByTelegramId, getDb } from '@oplati/db';
import type { TelegramUpdate } from '@oplati/types';

import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';

import { getBotUsername } from './bot';
import { sendStaffMessage } from './staff-bot-client';
import {
  CLIENT_BOT_FALLBACK_USERNAME,
  STAFF_BOT_IDLE_TEXT,
  STAFF_BOT_START_TEXT,
  staffBotOutsiderText,
} from './templates';

/**
 * Обработчик апдейтов бота ПЕРСОНАЛА.
 *
 * Задач у него ровно две, и обе маленькие:
 *   - сотруднику показать, что бот подключён (иначе человек не понимает, сделан
 *     ли шаг «запусти бота», без которого уведомления не дойдут);
 *   - постороннему ответить одной строкой и увести в клиентского бота. Боты
 *     публичны: клиент может найти `@oplatishkaasupport_bot` поиском по слову
 *     «support» и написать туда, ожидая поддержки.
 *
 * Никаких команд, кнопок и диалогов: чем меньше служебный бот умеет, тем меньше
 * у него поверхности.
 *
 * Никогда не бросает — вебхук обязан отвечать 200 (инвариант 6).
 */

const log = childLogger('telegram.staff-bot');

export async function handleStaffBotUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const fromId = message?.from?.id;
  const chatId = message?.chat.id;
  if (!message || fromId === undefined || chatId === undefined) return;

  // Свой бакет по отправителю: бот публичный, и поток сообщений от постороннего
  // иначе оплачивался бы чтением БД и исходящим сообщением на каждое.
  const rl = await checkRateLimit('staff-bot', String(fromId));
  if (!rl.allowed) {
    log.warn({ event: 'telegram.staff_bot.rate_limited' });
    return;
  }

  let isStaff: boolean;
  try {
    const staff = await findStaffByTelegramId(getDb(), String(fromId));
    isStaff = Boolean(staff?.isActive);
  } catch (err) {
    // База недоступна — молчим. Ответить постороннему от имени служебного бота
    // при неизвестном статусе отправителя хуже, чем не ответить вовсе.
    log.error({ event: 'telegram.staff_bot.lookup_failed', err });
    Sentry.captureException(err, { tags: { source: 'telegram.staff-bot' } });
    return;
  }

  const incoming = typeof message.text === 'string' ? message.text : '';
  const isStart = incoming === '/start' || incoming.startsWith('/start ');

  const text = isStaff
    ? isStart
      ? STAFF_BOT_START_TEXT
      : STAFF_BOT_IDLE_TEXT
    : staffBotOutsiderText(await resolveClientBotUsername());
  log.info({ event: 'telegram.staff_bot.replied', isStaff, isStart });

  try {
    await sendStaffMessage(chatId, text);
  } catch (err) {
    // Обычный случай — 403 «bot was blocked by the user». Это не наша авария и
    // точно не повод ретраить апдейт.
    log.warn({ event: 'telegram.staff_bot.send_failed', err });
  }
}

/**
 * Username КЛИЕНТСКОГО бота — резолвим через `getMe` (кэш на жизнь инстанса), а
 * не пишем строкой: имя уже менялось (переезд на `@oplatishkaa_bot` в июле), и
 * вторая копия рано или поздно оставила бы служебного бота со ссылкой на
 * мёртвый аккаунт. Сбой резолва — не повод молчать: берём известное имя.
 */
async function resolveClientBotUsername(): Promise<string> {
  try {
    return await getBotUsername();
  } catch (err) {
    log.warn({ event: 'telegram.staff_bot.client_username_failed', err });
    return CLIENT_BOT_FALLBACK_USERNAME;
  }
}
