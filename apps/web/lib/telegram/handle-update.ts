import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError, HttpError } from 'grammy';

import {
  appendMessage,
  consumeLinkToken,
  getDb,
  getLastAssistantMessageMeta,
  getOrCreateActiveConversation,
  getOrCreateUserByTelegramId,
  getOrderById,
  LINK_TOKEN_PREFIX,
  loadRecentMessages,
  resolveReferralCode,
  transitionOrder,
  type MessageHistoryItem,
} from '@oplati/db';
import { parseReferralCode, REFERRAL_DEEPLINK_PREFIX, type TelegramUser } from '@oplati/types';
import {
  classifyMessage,
  GREETING,
  runAgent,
  runAgentNoTools,
  type AgentMessage,
  type ProposeOrderResult,
  type RouteDecision,
  type RouteKind,
  type ToolCallLog,
} from '@oplati/agent';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@oplati/types';
import { InlineKeyboard } from 'grammy';

import {
  BUDGET_EXCEEDED_TEXT,
  isAiBudgetExceeded,
  mergeUsage,
  recordAgentUsage,
  type AgentUsageLike,
} from '@/lib/ai/budget';
import { captureReferralForUser } from '@/lib/cabinet/referral-capture';
import { miniAppUrl, paymentInstructionUrl, siteUrl } from '@/lib/deployment-url';
import { groupCatalog, type CatalogService } from '@/lib/catalog/build';
import { findCatalogService, loadCatalog } from '@/lib/catalog/load';
import { proposeFromCatalog } from '@/lib/catalog/propose';
import { formatExpires } from '@/components/comic/format';
import { serverEnv } from '@/lib/env';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';
import { createToolHandlers } from '@/lib/tool-handlers';
import { confirmOrder } from '@/lib/tool-handlers/confirm-order';

import { maxAmountUsdFor, parseCustomAmountUsd } from './amount';
import { getBot } from './bot';
import {
  catalogAmountInvalidText,
  CATALOG_BACK_BUTTON,
  CATALOG_LIST_PROMPT,
  CATALOG_OPEN_BUTTON,
  CATALOG_OWN_VARIANT_BUTTON,
  CATALOG_OWN_VARIANT_TEXT,
  CATALOG_UNAVAILABLE_TEXT,
  catalogCustomAmountPrompt,
  catalogTierButtonLabel,
  catalogTierPrompt,
  CHANNEL_MOCK_TEXT,
  MEDIA_REPLY,
  orderCardText,
  buildSupportOperatorMessage,
  START_APP_BUTTON,
  START_CHANNEL_BUTTON,
  START_HOWTO_BUTTON,
  START_SITE_BUTTON,
  START_SUPPORT_BUTTON,
  START_VPN_BUTTON,
  SUPPORT_ASK_TEXT,
  SUPPORT_BUTTON,
  SUPPORT_FAIL_TEXT,
  SUPPORT_SENT_TEXT,
  SUPPORT_UNAVAILABLE_TEXT,
  VPN_MOCK_TEXT,
  type MediaKind,
} from './templates';

/** Ключ pending-state в meta assistant-сообщения: «жду сумму для этого slug». */
const AWAITING_AMOUNT_META_KEY = 'awaiting_amount_for_slug';

/** Ключ pending-state в meta assistant-сообщения: «жду описание проблемы для /support». */
const AWAITING_SUPPORT_META_KEY = 'awaiting_support_message';

/**
 * Дефолтный получатель обращений /support, если `SUPPORT_OPERATOR_CHAT_ID` не
 * задан в env (telegram_id владельца). Оператор должен один раз запустить бота,
 * иначе Telegram запретит слать ему личные сообщения.
 */
const DEFAULT_SUPPORT_OPERATOR_CHAT_ID = '379336096';

/**
 * Диспатч одиночного Telegram update.
 *
 * Поведение:
 *   - `/start` (с любыми deep-link payload'ами после пробела) → отправить
 *     `GREETING` из `@oplati/agent`. До отправки — upsert пользователя и
 *     conversation, append двух сообщений (user `/start` + assistant GREETING).
 *   - Любой другой текст → upsert + append user-сообщения → один round-trip
 *     `runAgentNoTools` → append assistant-ответа → отправить (с разбивкой 4096).
 *   - Всё остальное (медиа, callback, edited_message, channel_post) — лог
 *     `telegram.update.ignored` и тихо игнорируем (на этом milestone).
 *
 * Запись в БД — синхронная, до возврата 200 OK Telegram'у. Все ошибки БД
 * перехватываются в `persistInbound` / `appendMessage` (не пробрасываются),
 * поэтому падение Postgres не ломает webhook: AI-ответ всё равно уходит
 * (graceful degradation). История диалога в AI-context НЕ загружается из БД —
 * это аудит-лог; контекст AI расширим в milestone «State machine + AI tools».
 */

const log = childLogger('telegram-bot');
const dbLog = childLogger('db');

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TYPING_REFRESH_MS = 4000;

/**
 * Показывает «печатает…» пользователю на всё время выполнения `fn`.
 * Telegram сам гасит индикатор через 5 сек, поэтому повторяем каждые 4 сек.
 * Ошибки sendChatAction не критичны — глотаем, чтобы не валить основной flow.
 */
async function withTypingIndicator<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const api = getBot().api;
  void api.sendChatAction(chatId, 'typing').catch(() => undefined);
  const interval = setInterval(() => {
    void api.sendChatAction(chatId, 'typing').catch(() => undefined);
  }, TYPING_REFRESH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

type PersistContext = {
  userId: string;
  conversationId: string;
};

/**
 * Upsert пользователя и активного conversation для входящего Telegram-сообщения.
 * Возвращает `null` при отсутствии `from.id` (channel post / anonymous) или при
 * ошибке БД — caller продолжает работу без записи.
 */
async function persistInbound(
  update: TelegramUpdate,
  message: TelegramMessage,
  opts?: { referredBy?: string | null },
): Promise<PersistContext | null> {
  if (!message.from?.id) {
    log.warn({
      event: 'telegram.persist.skipped',
      updateId: update.update_id,
      reason: 'no_from_id',
    });
    return null;
  }

  const startedAt = Date.now();
  const telegramId = String(message.from.id);
  const displayNameParts = [message.from.first_name, message.from.last_name].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  const displayName = displayNameParts.length > 0 ? displayNameParts.join(' ') : null;

  log.info({
    event: 'telegram.persist.start',
    updateId: update.update_id,
    chatId: message.chat.id,
  });

  try {
    const db = getDb();
    const user = await getOrCreateUserByTelegramId(
      db,
      {
        telegramId,
        displayName,
        language: message.from.language_code ?? 'ru',
        // referred_by ставится только при создании строки (см. репозиторий);
        // для не-/start апдейтов opts отсутствует → реферер не трогается.
        referredBy: opts?.referredBy ?? null,
      },
      dbLog,
    );
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'telegram' },
      dbLog,
    );

    log.info({
      event: 'telegram.persist.done',
      updateId: update.update_id,
      userId: user.id,
      conversationId: conversation.id,
      userCreated: user.created,
      conversationCreated: conversation.created,
      durationMs: Date.now() - startedAt,
    });

    return { userId: user.id, conversationId: conversation.id };
  } catch (err) {
    log.error({
      event: 'telegram.persist.failed',
      updateId: update.update_id,
      durationMs: Date.now() - startedAt,
      err,
    });
    Sentry.captureException(err, { tags: { source: 'telegram.persist' } });
    return null;
  }
}

/**
 * Добавить строку в `messages`. Ошибки БД глотаются (логируем + Sentry), чтобы
 * один сбой записи не ломал webhook. Возвращает `true`, если строка записана.
 */
async function safeAppendMessage(
  ctx: PersistContext,
  role: 'user' | 'assistant',
  content: string,
  meta: Record<string, unknown> | null,
  updateId: number,
): Promise<boolean> {
  try {
    await appendMessage(
      getDb(),
      {
        conversationId: ctx.conversationId,
        role,
        content,
        meta,
      },
      dbLog,
    );
    return true;
  } catch (err) {
    log.error({
      event: 'telegram.persist.message_failed',
      updateId,
      conversationId: ctx.conversationId,
      role,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: 'telegram.persist', step: 'appendMessage' },
    });
    return false;
  }
}

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
    log.info({
      event: 'telegram.start',
      chatId,
      telegramUserId,
      languageCode: message.from?.language_code,
    });

    // Deep-link привязки веб-сессии: /start link_<token> (кнопка «Связать
    // Telegram» на сайте). Обрабатываем ДО обычного приветствия.
    const startPayload = text.startsWith('/start ') ? text.slice('/start '.length).trim() : '';
    if (startPayload.startsWith(LINK_TOKEN_PREFIX)) {
      await handleLinkDeepLink(update, message, startPayload);
      return;
    }

    // Реферальный deep-link: /start ref_<code>. Резолвим реферера ДО persist,
    // чтобы getOrCreateUserByTelegramId проставил referred_by при СОЗДАНИИ строки
    // (immutable — повторный заход существующего юзера дерево не меняет).
    // Best-effort: любой сбой/неизвестный код → null (приветствие не ломаем).
    // Префикс ref_ обязателен (bare-код в /start рефералом не считаем), но
    // регистронезависимо — Telegram/клиенты могут прислать REF_ (находка ревью).
    const referredBy =
      serverEnv.REFERRAL_ENABLED &&
      startPayload.toLowerCase().startsWith(REFERRAL_DEEPLINK_PREFIX)
        ? await resolveReferrerFromStart(startPayload, update.update_id)
        : null;

    const ctx = await persistInbound(update, message, { referredBy });
    if (ctx) {
      // Поздний захват: если строка юзера уже существовала (напр. он раньше
      // открыл мини-апп кнопкой ☰ — тогда referred_by при создании не проставился),
      // INSERT выше реферера не тронул. setReferrerOnce привяжет его сейчас
      // (идемпотентно, с антифрод-гейтом по покупкам). Для нового юзера — no-op.
      if (referredBy) {
        await captureReferralForUser({
          userId: ctx.userId,
          referrerId: referredBy,
          source: 'bot_start',
        });
      }
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
      await safeAppendMessage(
        ctx,
        'assistant',
        GREETING,
        { source: 'static_greeting' },
        update.update_id,
      );
    }

    await sendSafely(chatId, GREETING, update.update_id, buildStartMenuKeyboard());
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
  // кнопки. Весь AI-путь ниже сохранён и работает при BOT_AI_ENABLED=1.
  if (!serverEnv.BOT_AI_ENABLED) {
    log.info({ event: 'telegram.message.ignored_ai_disabled', updateId: update.update_id, chatId });
    return;
  }

  // Дневной глобальный токен-бюджет (как в /api/chat): при превышении —
  // заготовленный ответ без единого вызова Anthropic.
  if (await isAiBudgetExceeded()) {
    log.warn({ event: 'telegram.budget_exceeded', updateId: update.update_id, chatId });
    if (ctx) {
      await safeAppendMessage(
        ctx,
        'assistant',
        BUDGET_EXCEEDED_TEXT,
        { source: 'budget_guard' },
        update.update_id,
      );
    }
    await sendSafely(chatId, BUDGET_EXCEEDED_TEXT, update.update_id);
    return;
  }

  const startedAt = Date.now();
  let routedAs: RouteKind = 'agent';
  let routerUsage: AgentUsageLike | null = null;
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await withTypingIndicator(chatId, async () => {
      // MVP-сценарий: search_catalog → propose_order → confirm_order. Без истории
      // AI забывает orderId из propose_order и не сможет вызвать confirm_order.
      // Подгружаем последние 20 user/assistant сообщений в хронологии. Текущее
      // user-сообщение уже записано в БД (safeAppendMessage выше), оно последнее.
      let agentHistory: AgentMessage[] = [{ role: 'user', content: text }];
      if (ctx) {
        let history: MessageHistoryItem[] = [];
        try {
          history = await loadRecentMessages(getDb(), ctx.conversationId, 20, dbLog);
        } catch (err) {
          log.warn({
            event: 'telegram.history.load_failed',
            updateId: update.update_id,
            conversationId: ctx.conversationId,
            err,
          });
        }
        agentHistory = toAgentHistory(history, text);
      }

      // Haiku-роутер: приветствие/оффтоп/инъекция → каннед-ответ без Sonnet.
      // Fail-open: упавший классификатор не блокирует агента.
      let route: RouteDecision = { route: 'agent', usage: null };
      try {
        route = await classifyMessage(agentHistory);
      } catch (err) {
        log.warn({ event: 'telegram.router_failed', updateId: update.update_id, err });
        Sentry.captureException(err, { tags: { source: 'telegram.router' } });
      }
      routerUsage = route.usage;

      if (route.route !== 'agent') {
        routedAs = route.route;
        // usage роутера уйдёт в счётчик как result.usage — не учитывать дважды
        routerUsage = null;
        return { text: route.cannedText, usage: route.usage, toolCalls: [] };
      }

      if (ctx) {
        const toolHandlers = createToolHandlers({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
        });
        return runAgent(agentHistory, {
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          channel: 'telegram',
          toolHandlers,
        });
      }
      const noToolsResult = await runAgentNoTools(agentHistory);
      return { ...noToolsResult, toolCalls: [] };
    });
  } catch (err) {
    log.error({
      event: 'telegram.agent.failed',
      updateId: update.update_id,
      chatId,
      err,
    });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
    await sendSafely(
      chatId,
      'Сейчас не получается ответить — что-то на нашей стороне. Попробуй ещё раз через минуту или напиши «оператор», и я подключу человека.',
      update.update_id,
    );
    return;
  }

  // Дневной счётчик: usage агента + Haiku-роутера (при каннед-ответе роутер уже в result).
  await recordAgentUsage(mergeUsage(routerUsage, result.usage));

  const durationMs = Date.now() - startedAt;
  const replyText = result.text.trim();

  if (!replyText) {
    log.warn({
      event: 'telegram.message.ai_reply_empty',
      updateId: update.update_id,
      chatId,
      durationMs,
    });
    return;
  }

  log.info({
    event: 'telegram.message.ai_reply',
    updateId: update.update_id,
    chatId,
    durationMs,
    // 'agent' — обычный путь; greeting/offtopic/injection — каннед без Sonnet
    routedAs,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    totalTokens: result.usage.input_tokens + result.usage.output_tokens,
    // Prompt caching: read > 0 — префикс tools+system пришёл из кэша (~0.1x цены)
    cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: result.usage.server_tool_use?.web_search_requests ?? 0,
    replyLength: replyText.length,
  });

  if (ctx) {
    await safeAppendMessage(
      ctx,
      'assistant',
      replyText,
      {
        telegram_update_id: update.update_id,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      },
      update.update_id,
    );
  }

  // Если последним tool'ом был успешный propose_order — приклеиваем к ответу
  // кнопки «Подтвердить»/«Отменить» вместо текстового вопроса.
  const proposeResult = extractProposeOrderResult(result.toolCalls);
  const chunks = splitForTelegram(replyText, TELEGRAM_MESSAGE_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    const isLast = i === chunks.length - 1;
    if (isLast && proposeResult) {
      await sendSafely(chatId, chunk, update.update_id, buildConfirmKeyboard(proposeResult.orderId));
    } else {
      await sendSafely(chatId, chunk, update.update_id);
    }
  }
}

const LINK_SUCCESS_TEXT =
  'Готово, Telegram привязан! Теперь чеки об оплате и доступы по заказам с сайта будут приходить сюда. Возвращайся на сайт — Оплатишка уже в курсе.';
const LINK_INVALID_TEXT =
  'Эта ссылка привязки устарела или уже использована. Вернись на сайт и нажми «Связать Telegram» ещё раз — пришлю свежую.';
const LINK_FAIL_TEXT =
  'Не получилось привязать прямо сейчас — что-то на нашей стороне. Попробуй ещё раз через минуту.';

/**
 * Завершение привязки веб-сессии: пользователь пришёл по deep-link
 * `t.me/<bot>?start=link_<token>` с сайта. Токен выпущен
 * `POST /api/auth/telegram/link`, потребление одноразовое (consumeLinkToken).
 *
 * Если у пользователя уже была история и в боте, и на сайте — consumeLinkToken
 * сольёт две users-строки в одну (выживает telegram-строка). Сообщения
 * персистим как обычный диалог, чтобы привязка была видна в истории.
 */
async function handleLinkDeepLink(
  update: TelegramUpdate,
  message: TelegramMessage,
  startPayload: string,
): Promise<void> {
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;

  if (!telegramUserId) {
    log.warn({ event: 'telegram.link.skipped', updateId: update.update_id, reason: 'no_from_id' });
    await sendSafely(chatId, LINK_FAIL_TEXT, update.update_id);
    return;
  }

  const token = startPayload.slice(LINK_TOKEN_PREFIX.length);
  const displayNameParts = [message.from?.first_name, message.from?.last_name].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );

  let replyText: string;
  try {
    const result = await consumeLinkToken(
      getDb(),
      {
        token,
        telegramId: String(telegramUserId),
        displayName: displayNameParts.length > 0 ? displayNameParts.join(' ') : null,
      },
      dbLog,
    );
    if (result.ok) {
      log.info({
        event: 'telegram.link.ok',
        updateId: update.update_id,
        userId: result.userId,
        merged: result.merged,
        alreadyLinked: result.alreadyLinked,
      });
      replyText = LINK_SUCCESS_TEXT;
    } else {
      log.info({ event: 'telegram.link.rejected', updateId: update.update_id, reason: result.reason });
      replyText = LINK_INVALID_TEXT;
    }
  } catch (err) {
    log.error({ event: 'telegram.link.failed', updateId: update.update_id, err });
    Sentry.captureException(err, { tags: { source: 'telegram.link' } });
    replyText = LINK_FAIL_TEXT;
  }

  // Персист диалога — обычный путь (после consumeLinkToken, чтобы upsert
  // пользователя не создал telegram-строку до merge без необходимости).
  const ctx = await persistInbound(update, message);
  if (ctx) {
    await safeAppendMessage(
      ctx,
      'user',
      '/start (привязка Telegram с сайта)',
      { telegram_update_id: update.update_id, telegram_message_id: message.message_id },
      update.update_id,
    );
    await safeAppendMessage(ctx, 'assistant', replyText, { source: 'telegram_link' }, update.update_id);
  }

  await sendSafely(chatId, replyText, update.update_id);
}

/**
 * Резолв реферера из payload `/start ref_<code>`. Best-effort: неизвестный код
 * или сбой БД → `null` (захвата нет, приветствие всё равно уходит). Самореферал
 * по Telegram структурно невозможен — существующий юзер попадает в ON CONFLICT
 * и referred_by не трогается; новый юзер своего кода ещё не имеет.
 */
async function resolveReferrerFromStart(
  startPayload: string,
  updateId: number,
): Promise<string | null> {
  const code = parseReferralCode(startPayload);
  if (!code) return null;
  try {
    const referrerId = await resolveReferralCode(getDb(), code);
    log.info({
      event: referrerId ? 'telegram.referral.captured' : 'telegram.referral.code_unknown',
      updateId,
    });
    return referrerId;
  } catch (err) {
    log.warn({ event: 'telegram.referral.resolve_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.referral' } });
    return null;
  }
}

/**
 * Достаёт результат последнего успешного `propose_order` вызова из лога tool calls
 * (после propose_order может ещё что-то быть, но кнопки делаем по самому свежему).
 */
function extractProposeOrderResult(toolCalls: ToolCallLog[]): ProposeOrderResult | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (!call) continue;
    if (call.name === 'propose_order' && !call.isError) {
      const out = call.output;
      if (
        typeof out === 'object' && out !== null &&
        'orderId' in out && typeof (out as { orderId: unknown }).orderId === 'string'
      ) {
        return out as ProposeOrderResult;
      }
    }
  }
  return null;
}

function buildConfirmKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Подтвердить', `confirm:${orderId}`)
    .text('Отменить', `cancel:${orderId}`);
}

/**
 * Inline-меню под приветствием /start (заменило постоянную reply-клавиатуру
 * 2026-07-02): Mini App (каталог + оплата + карта + партнёрка) — главный флоу,
 * поддержка — существующий callback `support`, VPN и канал — заглушки до
 * запуска продуктов. Тексты старых reply-кнопок («Выбрать сервис» /
 * «Написать в поддержку») по-прежнему перехватываются в handleTelegramUpdate —
 * у существующих пользователей клавиатура осталась раскрытой.
 */
function buildStartMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .webApp(START_APP_BUTTON, miniAppUrl())
    .row()
    .url(START_SITE_BUTTON, siteUrl())
    .row()
    .url(START_HOWTO_BUTTON, paymentInstructionUrl())
    .row()
    .text(START_SUPPORT_BUTTON, 'support')
    .row()
    .text(START_VPN_BUTTON, 'vpn')
    .row()
    .text(START_CHANNEL_BUTTON, 'channel');
}

/** Кнопка «<< Назад к списку» (вернуться к выбору сервиса). */
function buildBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(CATALOG_BACK_BUTTON, 'back');
}

/**
 * Клавиатура списка сервисов: заголовок темы строкой (не-кликабельный `noop`),
 * под ним сервисы по 2 в ряд; внизу «Свой вариант». Темы и порядок — общий
 * `groupCatalog` (тот же, что на сайте), чтобы список не висел сплошной стеной.
 */
function buildServiceListKeyboard(services: CatalogService[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groupCatalog(services)) {
    kb.text(`— ${group.label} —`, 'noop').row();
    for (let i = 0; i < group.services.length; i += 2) {
      const a = group.services[i];
      const b = group.services[i + 1];
      if (a) kb.text(a.name, `svc:${a.slug}`);
      if (b) kb.text(b.name, `svc:${b.slug}`);
      kb.row();
    }
  }
  kb.text(CATALOG_OWN_VARIANT_BUTTON, 'own');
  return kb;
}

/** Клавиатура тарифов сервиса: по одному в ряд (лейбл с ценой) + «Назад». */
function buildTierListKeyboard(slug: string, tiers: CatalogService['tiers']): InlineKeyboard {
  const kb = new InlineKeyboard();
  tiers.forEach((t, i) => {
    kb.text(catalogTierButtonLabel(t), `tier:${slug}:${i}`).row();
  });
  kb.text(CATALOG_BACK_BUTTON, 'back');
  return kb;
}

/**
 * Показать сообщение: редактирует существующее (`messageId` задан — навигация
 * по inline-кнопке, ощущение «экрана» как на сайте) либо отправляет новое
 * (`messageId` нет — /menu, ошибки в текстовом флоу). На edit-методах Telegram
 * пропущенный `reply_markup` снимает старую клавиатуру — то, что нужно при
 * переходе на текстовый экран. «message is not modified» — игнор; прочий сбой
 * edit (старое/удалённое сообщение) — fallback на отправку нового.
 */
async function showOrEdit(
  chatId: number,
  messageId: number | undefined,
  text: string,
  updateId: number,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (messageId === undefined) {
    await sendSafely(chatId, text, updateId, keyboard);
    return;
  }
  try {
    await getBot().api.editMessageText(
      chatId,
      messageId,
      text,
      keyboard ? { reply_markup: keyboard } : {},
    );
  } catch (err) {
    if (err instanceof GrammyError && /not modified/i.test(err.description)) {
      return;
    }
    log.debug({ event: 'telegram.callback.edit_failed', updateId, err });
    await sendSafely(chatId, text, updateId, keyboard);
  }
}

/**
 * Показать список сервисов кнопочного каталога (зеркало StartScreen сайта).
 * При недоступности каталога (БД/курс) — деградируем текстом, без падения.
 */
async function showCatalogList(
  chatId: number,
  messageId: number | undefined,
  updateId: number,
): Promise<void> {
  let services: CatalogService[] = [];
  try {
    services = await loadCatalog();
  } catch (err) {
    log.error({ event: 'telegram.catalog.load_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'load' } });
  }
  if (services.length === 0) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    CATALOG_LIST_PROMPT,
    updateId,
    buildServiceListKeyboard(services),
  );
}

/**
 * Резолвит пользователя и активный conversation по нажавшему кнопку
 * (`cb.from` обязателен по схеме). Нужен для записи pending-state и создания
 * заказа. `null` при недоступной БД — caller деградирует.
 */
async function resolveCallbackContext(
  cb: TelegramCallbackQuery,
  updateId: number,
): Promise<PersistContext | null> {
  try {
    const db = getDb();
    const nameParts = [cb.from.first_name, cb.from.last_name].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    const user = await getOrCreateUserByTelegramId(
      db,
      {
        telegramId: String(cb.from.id),
        displayName: nameParts.length > 0 ? nameParts.join(' ') : null,
        language: cb.from.language_code ?? 'ru',
      },
      dbLog,
    );
    const conversation = await getOrCreateActiveConversation(
      db,
      { userId: user.id, channel: 'telegram' },
      dbLog,
    );
    return { userId: user.id, conversationId: conversation.id };
  } catch (err) {
    log.error({ event: 'telegram.callback.resolve_ctx_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.callback', step: 'resolve_ctx' } });
    return null;
  }
}

/**
 * Диспетчер нажатий inline-кнопок. callback_data:
 *   - `noop`         → заголовок темы в каталоге (кнопка-разделитель, no-op);
 *   - `cat` / `back` → показать список сервисов (кнопочный каталог);
 *   - `own`          → подсказка «напиши текстом» (увод в чат с агентом);
 *   - `support`      → обращение в поддержку: просим описать проблему;
 *   - `vpn` / `channel` → заглушки стартового меню (продукты ещё не запущены);
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
      // Заглушка: VPN в разработке. Меню на исходном сообщении не трогаем.
      await sendSafely(chatId, VPN_MOCK_TEXT, updateId);
      return;
    case 'channel':
      // Заглушка: канал ещё не создан.
      await sendSafely(chatId, CHANNEL_MOCK_TEXT, updateId);
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
      const slug = parts[1];
      const idx = Number(parts[2]);
      if (slug && Number.isInteger(idx) && idx >= 0) {
        await handleTierSelected(cb, chatId, messageId, slug, idx, updateId);
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

/**
 * Выбран сервис (`svc:<slug>`). Сервис с фиксированными тарифами → показываем
 * тарифы. Custom-amount (Airbnb) → просим написать сумму и ставим pending-state
 * (флаг в meta assistant-сообщения), который подхватит следующий текст.
 */
async function handleServiceSelected(
  cb: TelegramCallbackQuery,
  chatId: number,
  messageId: number | undefined,
  slug: string,
  updateId: number,
): Promise<void> {
  let service: CatalogService | null = null;
  try {
    service = await findCatalogService(slug);
  } catch (err) {
    log.error({ event: 'telegram.catalog.service_lookup_failed', updateId, slug, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'svc' } });
  }
  if (!service) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }

  if (service.customAmount) {
    const ctx = await resolveCallbackContext(cb, updateId);
    if (!ctx) {
      await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
      return;
    }
    const prompt = catalogCustomAmountPrompt(service);
    // pending-state: следующий текст-число оформит заказ по этому slug мимо AI.
    await safeAppendMessage(
      ctx,
      'assistant',
      prompt,
      { source: 'catalog_ui', [AWAITING_AMOUNT_META_KEY]: slug },
      updateId,
    );
    await showOrEdit(chatId, messageId, prompt, updateId, buildBackKeyboard());
    return;
  }

  if (service.tiers.length === 0) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    catalogTierPrompt(service.name),
    updateId,
    buildTierListKeyboard(slug, service.tiers),
  );
}

/**
 * Выбран тариф (`tier:<slug>:<idx>`). Резолвим имя тарифа из каталога (цена
 * строго серверная) и создаём заказ через общий `proposeFromCatalog`. Успех —
 * редактируем сообщение в карточку заказа с кнопками «Подтвердить»/«Отменить».
 */
async function handleTierSelected(
  cb: TelegramCallbackQuery,
  chatId: number,
  messageId: number | undefined,
  slug: string,
  idx: number,
  updateId: number,
): Promise<void> {
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await showOrEdit(chatId, messageId, CATALOG_UNAVAILABLE_TEXT, updateId);
    return;
  }

  let service: CatalogService | null = null;
  try {
    service = await findCatalogService(slug);
  } catch (err) {
    log.error({ event: 'telegram.catalog.service_lookup_failed', updateId, slug, err });
    Sentry.captureException(err, { tags: { source: 'telegram.catalog', step: 'tier' } });
  }
  const tier = service?.tiers[idx];
  if (!service || !tier) {
    await showOrEdit(
      chatId,
      messageId,
      'Этот тариф уже недоступен. Нажми /menu, чтобы открыть список заново.',
      updateId,
    );
    return;
  }

  const result = await withTypingIndicator(chatId, () =>
    proposeFromCatalog({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      channel: 'telegram',
      slug,
      tierName: tier.name,
      tierPeriod: tier.period,
    }),
  );
  if (!result.ok) {
    await showOrEdit(chatId, messageId, result.text, updateId);
    return;
  }
  await showOrEdit(
    chatId,
    messageId,
    orderCardText(result.card),
    updateId,
    buildConfirmKeyboard(result.card.orderId),
  );
}

/**
 * Читает pending-state — meta последнего assistant-сообщения диалога. Сбой чтения
 * не должен блокировать обычный путь, поэтому возвращаем `null` (ожиданий нет).
 */
async function readPendingMeta(
  conversationId: string,
  updateId: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await getLastAssistantMessageMeta(getDb(), conversationId, dbLog);
  } catch (err) {
    log.warn({ event: 'telegram.pending_meta.failed', updateId, err });
    return null;
  }
}

/**
 * Кнопочный флоу: если бот ранее (выбор custom-amount сервиса) попросил сумму —
 * следующий текст трактуем как неё и оформляем заказ напрямую, мимо AI.
 * Возвращает `true`, если сообщение обработано здесь (caller прекращает обычный
 * путь). `meta` — pending-state (meta последнего assistant-сообщения), прочитан
 * вызывающим один раз.
 */
async function tryHandlePendingAmount(
  ctx: PersistContext,
  chatId: number,
  text: string,
  meta: Record<string, unknown> | null,
  updateId: number,
): Promise<boolean> {
  const slug = meta?.[AWAITING_AMOUNT_META_KEY];
  if (typeof slug !== 'string' || slug.length === 0) {
    return false;
  }

  const parsed = parseCustomAmountUsd(text, slug);
  if (parsed.kind === 'not_amount') {
    // Не число — пользователь сменил намерение; сброс ожидания, обычный путь.
    return false;
  }
  if (parsed.kind === 'invalid') {
    // Похоже на сумму, но вне диапазона/мусор — переспрашиваем, сохраняя флаг.
    const invalidText = catalogAmountInvalidText(maxAmountUsdFor(slug));
    await safeAppendMessage(
      ctx,
      'assistant',
      invalidText,
      { source: 'catalog_ui', [AWAITING_AMOUNT_META_KEY]: slug },
      updateId,
    );
    await sendSafely(chatId, invalidText, updateId);
    return true;
  }

  const result = await withTypingIndicator(chatId, () =>
    proposeFromCatalog({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      channel: 'telegram',
      slug,
      amountUsdCents: parsed.usdCents,
    }),
  );
  if (!result.ok) {
    // Заказ не создан — фиксируем ответ без флага (сброс ожидания).
    await safeAppendMessage(ctx, 'assistant', result.text, { source: 'catalog_ui' }, updateId);
    await sendSafely(chatId, result.text, updateId);
    return true;
  }
  // proposeFromCatalog уже записал след в историю (без флага) — ожидание сброшено.
  await sendSafely(
    chatId,
    orderCardText(result.card),
    updateId,
    buildConfirmKeyboard(result.card.orderId),
  );
  return true;
}

// ─── Поддержка (/support) — interim-handoff оператору ───────────────────────

/** «/support <текст>» / «/support@bot <текст>» → «<текст>»; «/support» → null. */
function extractSupportInline(text: string): string | null {
  const match = text.match(/^\/support(?:@\S+)?\s+([\s\S]+)$/);
  const body = match?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

/**
 * Пересылает обращение оператору в личку (Telegram ID из
 * `SUPPORT_OPERATOR_CHAT_ID`, иначе дефолт в коде). parse_mode HTML — сообщение
 * собирает чистый `buildSupportOperatorMessage` (экранирование + обрезка).
 * Возвращает `false` при сбое (в т.ч. 403 — оператор не запускал бота), чтобы
 * caller честно сообщил пользователю о неудаче.
 */
async function notifyOperator(operatorMessage: string, updateId: number): Promise<boolean> {
  const target = serverEnv.SUPPORT_OPERATOR_CHAT_ID ?? DEFAULT_SUPPORT_OPERATOR_CHAT_ID;
  try {
    await getBot().api.sendMessage(target, operatorMessage, { parse_mode: 'HTML' });
    log.info({ event: 'telegram.support.notified', updateId });
    return true;
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      // Оператор не запускал бота (или заблокировал) — DM невозможен. Критично.
      log.error({ event: 'telegram.support.operator_unreachable', updateId, target });
    } else {
      log.error({ event: 'telegram.support.notify_failed', updateId, err });
    }
    Sentry.captureException(err, { tags: { source: 'telegram.support' } });
    return false;
  }
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
async function handleSupportCommand(
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
async function handleSupportCallback(
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
async function tryHandlePendingSupport(
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

/**
 * Обработчик inline-кнопок «Подтвердить» / «Отменить» на карточке заказа.
 * Ownership: callback_data можно подделать через клиентский Bot API — нельзя
 * доверять orderId без проверки владельца. Резолвим userId по нажавшему и
 * передаём в confirmOrder / сверяем перед cancel. БД недоступна → отказ: весь
 * flow всё равно требует БД, проводить платёж по непроверенному заказу нельзя.
 */
async function handleOrderActionCallback(
  cb: TelegramCallbackQuery,
  chatId: number,
  action: 'confirm' | 'cancel',
  orderId: string,
  updateId: number,
): Promise<void> {
  const ctx = await resolveCallbackContext(cb, updateId);
  if (!ctx) {
    await sendSafely(
      chatId,
      'Не получилось обработать действие — попробуй ещё раз через минуту.',
      updateId,
    );
    return;
  }
  const userId = ctx.userId;

  // Снимем кнопки у исходного сообщения — нельзя нажать дважды.
  if (cb.message) {
    try {
      await getBot().api.editMessageReplyMarkup(chatId, cb.message.message_id);
    } catch (err) {
      log.debug({ event: 'telegram.callback.unmark_failed', updateId, err });
    }
  }

  if (action === 'confirm') {
    let confirmResult: Awaited<ReturnType<typeof confirmOrder>>;
    try {
      confirmResult = await withTypingIndicator(chatId, () => confirmOrder({ orderId, userId }));
    } catch (err) {
      log.error({ event: 'telegram.callback.confirm.failed', updateId, orderId, err });
      Sentry.captureException(err, {
        tags: { source: 'telegram.callback', step: 'confirm' },
        extra: { orderId },
      });
      await sendSafely(
        chatId,
        'Не получилось создать счёт прямо сейчас — техническая проблема на стороне платёжного провайдера. Я уже подключил оператора, он напишет в ближайшее время.',
        updateId,
      );
      return;
    }

    const replyParts = [`Счёт готов. Оплата:\n${confirmResult.paymentUrl}`];
    if (confirmResult.qrPayload) {
      replyParts.push('Или отсканируй QR-код в приложении банка по СБП.');
    }
    replyParts.push(`Счёт действует до ${formatExpires(confirmResult.expiresAt)}.`);
    const reply = replyParts.join('\n\n');

    await sendSafely(chatId, reply, updateId);
    return;
  }

  // action === 'cancel'
  try {
    const db = getDb();
    const order = await getOrderById(db, orderId);
    // Не раскрываем существование чужого заказа — тот же ответ, что и not-found.
    if (!order || order.userId !== userId) {
      if (order && order.userId !== userId) {
        log.warn({ event: 'telegram.callback.cancel.ownership_mismatch', updateId, orderId });
        Sentry.captureMessage('cancel callback: ownership mismatch', {
          level: 'warning',
          tags: { source: 'telegram.callback', step: 'cancel' },
          extra: { orderId },
        });
      }
      await sendSafely(chatId, 'Заказ уже не найден. Если хочешь начать заново — напиши /start.', updateId);
      return;
    }
    // cancel валиден только из draft/clarifying/ready_for_payment/pending_payment.
    // Если order уже paid/in_fulfillment/etc — transitionOrder бросит OrderTransitionError.
    await transitionOrder(db, {
      orderId,
      toStatus: 'cancelled',
      actorType: 'user',
      eventType: 'user_cancelled',
      payload: { source: 'telegram_inline_button' },
    });
    await sendSafely(chatId, 'Заказ отменён. Если передумаешь — напиши /start.', updateId);
  } catch (err) {
    log.error({ event: 'telegram.callback.cancel.failed', updateId, orderId, err });
    Sentry.captureException(err, {
      tags: { source: 'telegram.callback', step: 'cancel' },
      extra: { orderId },
    });
    await sendSafely(chatId, 'Не получилось отменить заказ. Напиши «оператор», подключу человека.', updateId);
  }
}

/**
 * Отправка с обработкой штатных ошибок (403 — заблокировал бота, 400 — bad
 * request на нашей стороне). Всё остальное — пробрасывается в Sentry, но
 * не пробрасывается дальше: webhook должен ответить 200.
 */
async function sendSafely(
  chatId: number,
  text: string,
  updateId: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await getBot().api.sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        log.warn({ event: 'telegram.send.blocked_by_user', updateId, chatId });
        return;
      }
      log.error({
        event: 'telegram.send.grammy_error',
        updateId,
        chatId,
        errorCode: err.error_code,
        description: err.description,
      });
      Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
      return;
    }
    if (err instanceof HttpError) {
      log.error({ event: 'telegram.send.http_error', updateId, chatId, err });
      Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
      return;
    }
    log.error({ event: 'telegram.send.unknown_error', updateId, chatId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.bot' } });
  }
}

/**
 * Конвертирует историю из БД в формат Anthropic messages.
 *
 * - `user` / `assistant` идут как есть.
 * - `operator` мапится на `assistant` (для AI оператор = "от имени сервиса").
 * - `system` отбрасывается (если бы такие были).
 *
 * Anthropic требует чередования user/assistant и чтобы последнее сообщение было
 * user. Текущий вход (`currentUserText`) уже записан в БД через safeAppendMessage
 * перед этим вызовом, так что он должен быть последним user в `history`.
 * На всякий случай — если последнее сообщение не user или history пуст, добавляем
 * currentUserText явно.
 *
 * Также сжимаем последовательные одинаковые роли в одно сообщение (объединяем
 * через \n\n) — Anthropic ругается на consecutive same-role messages.
 */
function toAgentHistory(
  history: MessageHistoryItem[],
  currentUserText: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const mapped = history
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'operator')
    .map((m) => ({
      role: (m.role === 'operator' ? 'assistant' : m.role) as 'user' | 'assistant',
      content: m.content,
    }));

  // Сжимаем consecutive same-role.
  const collapsed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of mapped) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      collapsed.push({ ...m });
    }
  }

  // Гарантируем что последнее сообщение — user.
  const last = collapsed[collapsed.length - 1];
  if (!last || last.role !== 'user') {
    collapsed.push({ role: 'user', content: currentUserText });
  }

  return collapsed;
}

/**
 * Разбивает текст на атомы для splitForTelegram:
 *   - каждая обычная строка — отдельный атом;
 *   - блок кода между парой строк ```...``` — один атом целиком,
 *     чтобы граница чанка не прошла внутри кода.
 *
 * Незакрытый ```-блок отдаётся как один большой атом (защита от моделей,
 * забывших закрыть fence).
 */
function tokenizeForSplit(text: string): string[] {
  const tokens: string[] = [];
  let inCode = false;
  let buf: string[] = [];
  for (const line of text.split('\n')) {
    const isFence = line.startsWith('```');
    if (isFence) {
      if (!inCode) {
        inCode = true;
        buf = [line];
      } else {
        buf.push(line);
        tokens.push(buf.join('\n'));
        buf = [];
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
    } else {
      tokens.push(line);
    }
  }
  if (buf.length > 0) tokens.push(buf.join('\n'));
  return tokens;
}

/**
 * Режем длинный ответ AI на куски ≤ `limit`. Сначала пытаемся по границам
 * строк и code-блоков, чтобы не разрывать смысл; если атом всё равно слишком
 * большой (длинный код или строка без \n) — режем по символам.
 */
export function splitForTelegram(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let buffer = '';

  for (const token of tokenizeForSplit(text)) {
    const candidate = buffer ? `${buffer}\n${token}` : token;
    if (candidate.length <= limit) {
      buffer = candidate;
      continue;
    }
    if (buffer) {
      result.push(buffer);
      buffer = '';
    }
    if (token.length <= limit) {
      buffer = token;
      continue;
    }
    for (let i = 0; i < token.length; i += limit) {
      result.push(token.slice(i, i + limit));
    }
  }
  if (buffer) result.push(buffer);
  return result;
}
