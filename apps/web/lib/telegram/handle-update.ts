import 'server-only';

import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';

import { runAgentDialog } from './agent-dialog';
import { getBot } from './bot';
import {
  handleOrderActionCallback,
  handleServiceSelected,
  handleTierSelected,
  showCatalogList,
  tryHandlePendingAmount,
} from './catalog-callbacks';
import { persistInbound, readPendingMeta, safeAppendMessage } from './persist';
import { sendSafely, showOrEdit } from './send';
import { handleStartCommand } from './start-menu';
import {
  handleSupportCallback,
  handleSupportCommand,
  tryHandlePendingSupport,
} from './support-flow';
import {
  CATALOG_OPEN_BUTTON,
  CATALOG_OWN_VARIANT_TEXT,
  CHANNEL_LINK_TEXT,
  MEDIA_REPLY,
  SUPPORT_BUTTON,
  type MediaKind,
} from './templates';
import { handleVpnCallback, handleVpnRefreshCallback } from './vpn-flow';

/**
 * Тонкий роутер Telegram-апдейтов (распил M-10 аудита, 2026-07: прежний
 * 1700-строчный файл разнесён по флоу, поведение 1:1):
 *   - `persist.ts`        — upsert user/conversation, запись диалога, pending-meta;
 *   - `send.ts`           — sendSafely/showOrEdit/typing/splitForTelegram;
 *   - `start-menu.ts`     — /start, deep-link'и ref_, inline-меню приветствия;
 *   - `link-flow.ts`      — /start link_<token>: привязка веб-сессии + handoff заказа;
 *   - `support-flow.ts`   — /support и callback support (interim-handoff оператору);
 *   - `catalog-callbacks.ts` — кнопочный каталог, custom-amount, confirm/cancel;
 *   - `agent-dialog.ts`   — AI-путь (бюджет → роутер → runAgent → ответ).
 *
 * Здесь остаётся только диспатч: какой апдейт в какой флоу. Запись в БД —
 * синхронная, до возврата 200 OK Telegram'у; все ошибки БД перехватываются
 * внутри persist-модуля, поэтому падение Postgres не ломает webhook
 * (graceful degradation — бот отвечает, но «забывает» историю).
 */

const log = childLogger('telegram-bot');

/**
 * Определяет тип медиа-вложения для шаблонного ответа.
 * Возвращает `null`, если медиа не найдено (например, edited_message без текста).
 */
function detectMediaKind(message: TelegramMessage): MediaKind | null {
  if (message.photo) return 'photo';
  if (message.voice) return 'voice';
  if (message.video_note) return 'video_note';
  if (message.audio) return 'audio';
  if (message.video) return 'video';
  if (message.document) return 'document';
  if (message.sticker) return 'sticker';
  if (message.animation) return 'animation';
  return null;
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  // Inline-кнопки приходят как callback_query (не message). Обрабатываем отдельной веткой.
  if (update.callback_query) {
    await handleCallbackQuery(update, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) {
    log.warn({ event: 'telegram.update.ignored', updateId: update.update_id, kind: 'no_message' });
    return;
  }

  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;

  // Если есть text — нормальный путь. Caption приравниваем к text (фото со
  // словами «нужен ChatGPT» — нормальный продуктовый кейс).
  const rawText =
    typeof message.text === 'string' && message.text.length > 0
      ? message.text
      : typeof message.caption === 'string' && message.caption.trim().length > 0
        ? message.caption
        : null;

  if (rawText === null) {
    const mediaKind = detectMediaKind(message);
    if (mediaKind) {
      log.info({
        event: 'telegram.update.handled',
        updateId: update.update_id,
        chatId,
        telegramUserId,
        kind: 'media',
        mediaType: mediaKind,
      });
      // При выключенном BOT_AI_ENABLED бот не реагирует на сообщения (работают
      // только команды/кнопки) — на медиа молчим.
      if (serverEnv.BOT_AI_ENABLED) {
        await sendSafely(chatId, MEDIA_REPLY[mediaKind], update.update_id);
      }
      return;
    }
    // edited_message без текста, system-сообщения и т.п. — тихо игнорируем.
    log.warn({ event: 'telegram.update.ignored', updateId: update.update_id, kind: 'no_text' });
    return;
  }

  const text = rawText;
  const isFromCaption = !message.text && message.caption !== undefined;
  if (isFromCaption) {
    const mediaKind = detectMediaKind(message);
    log.info({
      event: 'telegram.update.handled',
      updateId: update.update_id,
      chatId,
      telegramUserId,
      kind: 'media_with_caption',
      mediaType: mediaKind,
    });
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await handleStartCommand(update, message, chatId, text);
    return;
  }

  // /menu — открыть кнопочный каталог в любой момент (зеркало кнопки «Выбрать
  // сервис» на сайте). Навигация без AI — обрабатываем до rate-limit/агента.
  // Сюда же попадает нажатие постоянной reply-кнопки «Выбрать сервис» (она шлёт
  // свой лейбл обычным текстом) — так меню открывается одинаково из команды и кнопки.
  if (
    text === '/menu' ||
    text.startsWith('/menu ') ||
    text.startsWith('/menu@') ||
    text === CATALOG_OPEN_BUTTON
  ) {
    // Кнопочный каталог в чате — за флагом BOT_AI_ENABLED. Выключен (по умолчанию,
    // 2026-07-03) → бот молчит (реагируют только команды/кнопки). Код каталога цел.
    if (!serverEnv.BOT_AI_ENABLED) {
      log.info({ event: 'telegram.menu_ignored', chatId, telegramUserId });
      return;
    }
    log.info({ event: 'telegram.menu', chatId, telegramUserId });
    await showCatalogList(chatId, undefined, update.update_id);
    return;
  }

  // Per-identity rate-limit ДО persist/роутера/агента: режет DoS-на-бюджет от
  // одного пользователя. `/start` и привязка обрабатываются выше и не затронуты.
  const rlIdentity = String(telegramUserId ?? chatId);
  const rl = await checkRateLimit('telegram', rlIdentity);
  if (!rl.allowed) {
    log.warn({ event: 'telegram.rate_limited', updateId: update.update_id, chatId });
    await sendSafely(
      chatId,
      'Слишком много сообщений подряд. Подожди минутку и напиши снова — я никуда не денусь.',
      update.update_id,
    );
    return;
  }

  // /support — обращение в поддержку (interim-handoff оператору). ПОСЛЕ
  // rate-limit: inline-форма `/support <текст>` сразу шлёт человеку, спам недопустим.
  // Нажатие постоянной reply-кнопки «Написать в поддержку» шлёт свой лейбл текстом
  // без префикса — extractSupportInline вернёт null, и handleSupportCommand уйдёт в
  // двухшаговый флоу (попросит описать проблему), а не отправит пустое обращение.
  if (
    text === '/support' ||
    text.startsWith('/support ') ||
    text.startsWith('/support@') ||
    text === SUPPORT_BUTTON
  ) {
    await handleSupportCommand(update, message, chatId, text);
    return;
  }

  log.info({
    event: 'telegram.message.user',
    updateId: update.update_id,
    chatId,
    telegramUserId,
    textLength: text.length,
  });

  const ctx = await persistInbound(update, message);
  if (ctx) {
    await safeAppendMessage(
      ctx,
      'user',
      text,
      {
        telegram_update_id: update.update_id,
        telegram_message_id: message.message_id,
      },
      update.update_id,
    );

    // Pending-state читаем ОДИН раз (meta последнего assistant-сообщения) и
    // диспатчим: ожидание описания для /support ИЛИ ожидание суммы для
    // custom-amount сервиса. Оба — быстрый путь мимо AI.
    const pendingMeta = await readPendingMeta(ctx.conversationId, update.update_id);

    // Флоу поддержки: бот ранее попросил описать проблему — этот текст пересылаем
    // оператору.
    if (await tryHandlePendingSupport(ctx, message, chatId, text, pendingMeta, update.update_id)) {
      return;
    }

    // Кнопочный флоу custom-amount (Airbnb и т.п.) — часть каталога, за флагом
    // BOT_AI_ENABLED. Выключен → пропускаем (обычный путь ниже уведёт в Mini App).
    if (
      serverEnv.BOT_AI_ENABLED &&
      (await tryHandlePendingAmount(ctx, chatId, text, pendingMeta, update.update_id))
    ) {
      return;
    }
  }

  // Взаимодействие с Оплатишкой (AI-диалог) в чате бота — за флагом BOT_AI_ENABLED.
  // Выключено (по умолчанию, 2026-07-03): бот НЕ реагирует на текст (молчит) — не
  // дёргаем агента/роутер/бюджет. Работают только команды (/start, /support) и
  // кнопки. Весь AI-путь сохранён и работает при BOT_AI_ENABLED=1.
  if (!serverEnv.BOT_AI_ENABLED) {
    log.info({ event: 'telegram.message.ignored_ai_disabled', updateId: update.update_id, chatId });
    return;
  }

  await runAgentDialog(update, chatId, text, ctx);
}

/**
 * Диспетчер нажатий inline-кнопок. callback_data:
 *   - `noop`         → заголовок темы в каталоге (кнопка-разделитель, no-op);
 *   - `cat` / `back` → показать список сервисов (кнопочный каталог);
 *   - `own`          → подсказка «напиши текстом» (увод в чат с агентом);
 *   - `support`      → обращение в поддержку: просим описать проблему;
 *   - `vpn`          → выдать ссылку-подписку VPN (Remnawave, vpn-flow.ts);
 *   - `vpn:refresh`  → перевыпустить ссылку (revoke в панели + новая ссылка);
 *   - `channel`      → легаси старых меню: ссылка на Telegram-канал;
 *   - `svc:<slug>`   → выбран сервис: тарифы или запрос суммы (custom-amount);
 *   - `tier:<slug>:<idx>` → выбран тариф: создать заказ → кнопки confirm/cancel;
 *   - `confirm:<orderId>` → confirmOrder (создание L&P invoice) + ссылка оплаты;
 *   - `cancel:<orderId>`  → transitionOrder → cancelled.
 *
 * Telegram требует ответить на callback_query через `answerCallbackQuery` —
 * иначе кнопка крутится у пользователя до таймаута (~15s).
 */
async function handleCallbackQuery(
  update: TelegramUpdate,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const updateId = update.update_id;
  const data = cb.data ?? '';
  const parts = data.split(':');
  const action = parts[0] ?? '';

  log.info({ event: 'telegram.callback.received', updateId, chatId, action });

  // Сразу подтверждаем callback (Telegram перестанет крутить кнопку).
  try {
    await getBot().api.answerCallbackQuery(cb.id);
  } catch (err) {
    log.warn({ event: 'telegram.callback.answer_failed', updateId, err });
  }

  if (!chatId) {
    log.warn({ event: 'telegram.callback.invalid', updateId, data });
    return;
  }

  // Rate-limit на КНОПКИ (аудит 2026-07-28). Раньше лимит стоял только на
  // текстовом пути, а callback'и уходили мимо — при том, что за ними живут
  // внешние вызовы: `vpn`/`vpn:refresh` создают и отзывают юзеров в панели
  // Remnawave, `confirm:<orderId>` выставляет счёт у платёжного шлюза, а
  // резолв контекста делает INSERT в `users`. Зажатая кнопка = сотни обращений
  // в минуту. Бакет общий с текстом: это один и тот же пользователь.
  const cbIdentity = String(cb.from?.id ?? chatId);
  const cbRl = await checkRateLimit('telegram', cbIdentity);
  if (!cbRl.allowed) {
    log.warn({ event: 'telegram.callback.rate_limited', updateId, chatId, action });
    await sendSafely(
      chatId,
      'Слишком много нажатий подряд. Подожди минутку и попробуй снова.',
      updateId,
    );
    return;
  }

  // Кнопочный каталог в чате — за флагом BOT_AI_ENABLED. Выключен (по умолчанию,
  // 2026-07-03) → каталожные кнопки (в т.ч. старые в истории чата) не реагируют
  // (callback уже подтверждён выше — кнопка не крутится). support / vpn / channel /
  // confirm / cancel работают как обычно.
  if (
    !serverEnv.BOT_AI_ENABLED &&
    ['noop', 'cat', 'back', 'own', 'svc', 'tier'].includes(action)
  ) {
    return;
  }

  switch (action) {
    case 'noop':
      // Заголовок темы в каталоге — кнопка-разделитель, действия нет.
      return;
    case 'cat':
    case 'back':
      await showCatalogList(chatId, messageId, updateId);
      return;
    case 'own':
      await showOrEdit(chatId, messageId, CATALOG_OWN_VARIANT_TEXT, updateId);
      return;
    case 'support':
      await handleSupportCallback(cb, chatId, updateId);
      return;
    case 'vpn':
      // VPN Оплатишки: выдача/перевыпуск ссылки-подписки Remnawave.
      if (parts[1] === 'refresh') {
        await handleVpnRefreshCallback(cb, chatId, updateId);
        return;
      }
      await handleVpnCallback(cb, chatId, updateId);
      return;
    case 'channel':
      // Легаси: в новых меню это url-кнопка. Callback приходит только со старых
      // сообщений — отвечаем ссылкой на канал.
      await sendSafely(chatId, CHANNEL_LINK_TEXT, updateId);
      return;
    case 'svc': {
      const slug = parts[1];
      if (slug) {
        await handleServiceSelected(cb, chatId, messageId, slug, updateId);
        return;
      }
      break;
    }
    case 'tier': {
      // `tier:<slug>:<period>:<usdCents>` — стабильный ключ (L-20); легаси
      // `tier:<slug>:<idx>` resolveTier осознанно отвергает («тариф недоступен»).
      const slug = parts[1];
      if (slug && parts.length >= 3) {
        await handleTierSelected(cb, chatId, messageId, slug, parts.slice(2), updateId);
        return;
      }
      break;
    }
    case 'confirm':
    case 'cancel': {
      const orderId = parts[1];
      if (orderId) {
        await handleOrderActionCallback(cb, chatId, action, orderId, updateId);
        return;
      }
      break;
    }
    default:
      break;
  }
  log.warn({ event: 'telegram.callback.invalid', updateId, data });
}

// Публичный реэкспорт (истор. путь импорта): реализация переехала в send.ts.
export { splitForTelegram } from './send';
