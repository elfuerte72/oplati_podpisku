import 'server-only';

import type { TelegramCallbackQuery } from '@oplati/types';

import { SUPPORT_ALREADY_OPEN } from '@/lib/support/texts';

import { resolveCallbackContext } from './persist';
import { sendSafely } from './send';
import { handleSupportCallback } from './support-flow';
import { openSupportFromBot } from './support-session';

/**
 * Общий вход в поддержку ПО КНОПКЕ: помощник (если включён и состояние
 * читается) либо сегодняшний двухшаговый флоу к человеку. Выделен из
 * `case 'support'` диспетчера, когда у него появился второй вызывающий —
 * кнопка «Другое» в опросах воронки (правило В3: обращение создаётся только
 * кнопкой, и дверь у всех кнопок одна).
 */
export async function openSupportEntry(
  cb: TelegramCallbackQuery,
  chatId: number,
  updateId: number,
): Promise<void> {
  // Режим разговора читается при ЛЮБОМ флаге (crm-serious-fixes, тикет 01).
  // Модуль сам знает, доступен ли помощник: без него свободный разговор
  // отдаёт `unavailable` (сегодняшний двухшаговый флоу), а разговор у
  // оператора — «обращение уже у оператора». Раньше при выключенном помощнике
  // кнопка просила «опишите проблему» и там, где диалог уже вёл человек, —
  // а описание потом тихо ложилось в обращение без ответа клиенту.
  const ctx = await resolveCallbackContext(cb, updateId);
  if (ctx) {
    const opened = await openSupportFromBot(ctx, chatId, updateId, cb.from, 'button');
    if (opened.status === 'already_open') {
      await sendSafely(chatId, SUPPORT_ALREADY_OPEN, updateId);
    }
    if (opened.status !== 'unavailable') return;
  }
  // Помощника нет или состояние не прочитать — сегодняшний флоу (он умеет без
  // него). Контекст уже получен, второй upsert клиента не нужен.
  await handleSupportCallback(cb, chatId, updateId, ctx);
}
