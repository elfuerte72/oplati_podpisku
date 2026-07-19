import 'server-only';

import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from '@oplati/types';

import { childLogger } from '@/lib/logger';

import { persistInbound, readPendingMeta, resolveCallbackContext, safeAppendMessage, type PersistContext } from './persist';
import { sendSafely } from './send';
import { sendToSupportOperator } from './support';
import {
  buildSupportOperatorMessage,
  SUPPORT_ASK_TEXT,
  SUPPORT_FAIL_TEXT,
  SUPPORT_SENT_TEXT,
  SUPPORT_UNAVAILABLE_TEXT,
} from './templates';

/**
 * Поддержка (/support) — interim-handoff оператору (выделено из
 * handle-update.ts при распиле M-10, поведение 1:1). Это НЕ двусторонний
 * диалог: бот пересылает обращение в личку оператора, тот отвечает вручную.
 */

const log = childLogger('telegram-bot');

/** Ключ pending-state в meta assistant-сообщения: «жду описание проблемы для /support». */
const AWAITING_SUPPORT_META_KEY = 'awaiting_support_message';

/** «/support <текст>» / «/support@bot <текст>» → «<текст>»; «/support» → null. */
function extractSupportInline(text: string): string | null {
  const match = text.match(/^\/support(?:@\S+)?\s+([\s\S]+)$/);
  const body = match?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

/**
 * Пересылает обращение оператору в личку (общий помощник `sendToSupportOperator`:
 * получатель из `SUPPORT_OPERATOR_CHAT_ID`, parse_mode HTML). Возвращает `false`
 * при сбое, чтобы caller честно сообщил пользователю о неудаче.
 */
async function notifyOperator(operatorMessage: string, updateId: number): Promise<boolean> {
  return sendToSupportOperator(operatorMessage, { updateId });
}

/**
 * Собирает данные пользователя + описание и шлёт оператору. `from` берётся из
 * входящего сообщения (личность отправителя, подделать нельзя). `null`/без id —
 * невозможно идентифицировать клиента, обращение не отправляем.
 */
async function submitSupportRequest(
  from: TelegramUser | undefined,
  description: string,
  updateId: number,
): Promise<boolean> {
  if (!from?.id) {
    log.warn({ event: 'telegram.support.no_from', updateId });
    return false;
  }
  const operatorMessage = buildSupportOperatorMessage({
    telegramId: from.id,
    firstName: from.first_name,
    lastName: from.last_name,
    username: from.username,
    description,
  });
  return notifyOperator(operatorMessage, updateId);
}

/**
 * Команда `/support`. Два режима:
 *   - inline «/support <текст>» — пересылаем оператору сразу (работает даже при
 *     недоступной БД: личность берём из update, история — best-effort);
 *   - «/support» без аргументов — просим описать проблему и ставим pending-флаг
 *     в meta assistant-сообщения (следующий текст подхватит tryHandlePendingSupport).
 *
 * Уже за rate-limit'ом (вызывается из основного диспатчера после проверки).
 */
export async function handleSupportCommand(
  update: TelegramUpdate,
  message: TelegramMessage,
  chatId: number,
  text: string,
): Promise<void> {
  const updateId = update.update_id;
  log.info({ event: 'telegram.support.command', chatId, telegramUserId: message.from?.id });

  const inline = extractSupportInline(text);
  if (inline) {
    const ok = await submitSupportRequest(message.from, inline, updateId);
    const reply = ok ? SUPPORT_SENT_TEXT : SUPPORT_FAIL_TEXT;
    const ctx = await persistInbound(update, message);
    if (ctx) {
      await safeAppendMessage(
        ctx,
        'user',
        text,
        { telegram_update_id: updateId, telegram_message_id: message.message_id },
        updateId,
      );
      await safeAppendMessage(ctx, 'assistant', reply, { source: 'support' }, updateId);
    }
    await sendSafely(chatId, reply, updateId);
    return;
  }

  // Двухшаговый флоу: нужен conversationId, чтобы записать pending-флаг.
  const ctx = await persistInbound(update, message);
  if (!ctx) {
    // БД недоступна — флаг сохранить негде. Направляем на inline-форму (без БД).
    await sendSafely(chatId, SUPPORT_UNAVAILABLE_TEXT, updateId);
    return;
  }
  await safeAppendMessage(
    ctx,
    'user',
    text,
    { telegram_update_id: updateId, telegram_message_id: message.message_id },
    updateId,
  );
  await safeAppendMessage(
    ctx,
    'assistant',
    SUPPORT_ASK_TEXT,
    { source: 'support', [AWAITING_SUPPORT_META_KEY]: true },
    updateId,
  );
  await sendSafely(chatId, SUPPORT_ASK_TEXT, updateId);
}

/**
 * Нажатие inline-кнопки «Написать в поддержку» (callback `support`). Ставит тот
 * же pending-флаг, что и `/support` без аргументов, и просит описать проблему
 * новым сообщением (приветствие/каталог не редактируем — оставляем контекст).
 *
 * Callback-путь не проходит через message-rate-limit, поэтому идемпотентен к
 * «дребезгу» кнопки: если описание уже ждём (флаг — последняя assistant-meta),
 * повторные нажатия не плодят строки в БД и повторные подсказки (находка greptile).
 *
 * Осознанно: если пользователь был в custom-amount флоу (ждали сумму) и нажал
 * поддержку — это явная смена намерения, флаг поддержки перекрывает ожидание
 * суммы, и следующее сообщение уходит оператору (а не оформляет заказ).
 */
export async function handleSupportCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  updateId: number,
): Promise<void> {
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await sendSafely(chatId, SUPPORT_UNAVAILABLE_TEXT, updateId);
    return;
  }
  const meta = await readPendingMeta(ctx.conversationId, updateId);
  if (meta?.[AWAITING_SUPPORT_META_KEY] === true) {
    // Уже ждём описание — не дублируем (callback уже подтверждён answerCallbackQuery).
    return;
  }
  // Клавиатуру исходного сообщения НЕ трогаем: кнопка живёт в стартовом меню
  // (Mini App / VPN / канал), и снятие/замена markup ломала бы всё меню ради
  // дедупа. Дребезг закрывает idempotent-проверка pending-флага выше.
  await safeAppendMessage(
    ctx,
    'assistant',
    SUPPORT_ASK_TEXT,
    { source: 'support', [AWAITING_SUPPORT_META_KEY]: true },
    updateId,
  );
  await sendSafely(chatId, SUPPORT_ASK_TEXT, updateId);
}

/**
 * Флоу поддержки: если бот ранее попросил описать проблему (pending-флаг в meta),
 * этот текст трактуем как описание и пересылаем оператору. Возвращает `true`,
 * если сообщение обработано здесь. `meta` прочитан вызывающим один раз.
 */
export async function tryHandlePendingSupport(
  ctx: PersistContext,
  message: TelegramMessage,
  chatId: number,
  text: string,
  meta: Record<string, unknown> | null,
  updateId: number,
): Promise<boolean> {
  if (meta?.[AWAITING_SUPPORT_META_KEY] !== true) {
    return false;
  }
  const ok = await submitSupportRequest(message.from, text, updateId);
  const reply = ok ? SUPPORT_SENT_TEXT : SUPPORT_FAIL_TEXT;
  // Ответ без флага — ожидание сброшено (успех) либо не зацикливаем на сбое.
  await safeAppendMessage(ctx, 'assistant', reply, { source: 'support' }, updateId);
  await sendSafely(chatId, reply, updateId);
  return true;
}
