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

/**
 * Бот персонала не настроен (нет токена). Отдельный класс, потому что это
 * АВАРИЯ КОНФИГУРАЦИИ, а не отказ Telegram, и вызывающий обязан отличать одно
 * от другого.
 */
export class StaffBotNotConfiguredError extends Error {
  constructor() {
    super('TELEGRAM_LOGIN_BOT_TOKEN не задан — бот персонала недоступен');
    this.name = 'StaffBotNotConfiguredError';
  }
}

/**
 * Отправить сообщение сотруднику. Бросает — вызывающий решает, что с этим.
 *
 * ⚠️ Незаданный токен тоже БРОСАЕТ, а не молчит. Прежняя версия писала warn и
 * возвращала `void`, то есть «ничего не отправлено» было неотличимо от
 * «отправлено»: обращение клиента считалось доставленным, клиент получал
 * «передали в поддержку», в панели горело «доставлено», а сообщение не уходило
 * никуда. Это единственный канал связи с клиентом — молчать здесь нельзя.
 */
export async function sendStaffMessage(
  chatId: number | string,
  text: string,
  opts: SendStaffMessageOptions = {},
): Promise<void> {
  const bot = getStaffBot();
  if (!bot) {
    log.error({ event: 'telegram.staff_bot.not_configured' });
    throw new StaffBotNotConfiguredError();
  }
  // Третий аргумент добавляем ТОЛЬКО при заданной теме: существующие вызовы
  // и их тесты сверяют ровно два аргумента, а `{ message_thread_id: undefined }`
  // в личке — лишний ключ в теле запроса к Bot API.
  if (opts.messageThreadId === undefined) {
    await bot.api.sendMessage(chatId, text);
    return;
  }
  await bot.api.sendMessage(chatId, text, { message_thread_id: opts.messageThreadId });
}

export type SendStaffMessageOptions = {
  /**
   * Тема супергруппы (ops-группа с темами). В личке не используется:
   * `message_thread_id` там означает другое (ответ в треде) и ломает отправку.
   */
  messageThreadId?: number;
};
