import 'server-only';

import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { trackServer } from '@/lib/analytics/track';
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
import { handleContactMessage } from './contact-flow';
import { persistInbound, readPendingMeta, resolveCallbackContext, safeAppendMessage } from './persist';
import { sendSafely, showOrEdit } from './send';
import {
  buildSupportHintKeyboard,
  claimMediaGroup,
  claimSilentHint,
  releaseSilentHint,
} from './silent-hint';
import { handleFunnelCallback } from './funnel-callbacks';
import { notifyStaffAboutInboundMessage } from './inbound-alert';
import { handleStartCommand } from './start-menu';
import { openSupportEntry } from './support-entry';
import { handlePrivacyCommand, isPrivacyCommand } from './privacy-command';
import {
  extractSupportInline,
  handleSupportCommand,
  tryHandlePendingSupport,
} from './support-flow';
import {
  finishSupportFromBot,
  openSupportFromBot,
  routeSupportIncoming,
} from './support-session';
import {
  CATALOG_OPEN_BUTTON,
  CATALOG_OWN_VARIANT_TEXT,
  CHANNEL_LINK_TEXT,
  MEDIA_REPLY,
  SILENT_MEDIA_HINT,
  SILENT_TEXT_HINT,
  SUPPORT_BUTTON,
  type MediaKind,
} from './templates';
import { handleVpnCallback, handleVpnRefreshCallback } from './vpn-flow';
import {
  SUPPORT_ALREADY_OPEN,
  supportMediaContent,
} from '@/lib/support/texts';

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
/** `/start` с любым deep-link payload'ом (`ref_`, `link_`, `cabinet`). */
function isStartCommand(text: string): boolean {
  return text === '/start' || text.startsWith('/start ');
}

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

/**
 * Одна подсказка вместо молчания (тикет 09) — с дедупом на отправителя.
 *
 * Возвращает `true`, если сообщение реально ушло. Дедуп живёт в `silent-hint.ts`
 * и закрывает два случая сразу: альбом (Telegram шлёт апдейт на каждое фото) и
 * серию сообщений от человека, которому не ответили по делу.
 */
async function sendSilentHint(
  chatId: number,
  identity: string,
  text: string,
  updateId: number,
): Promise<boolean> {
  if (!(await claimSilentHint(identity))) return false;

  const delivered = await sendSafely(chatId, text, updateId, buildSupportHintKeyboard());
  if (!delivered) {
    // Клиент заблокировал бота или Telegram ответил ошибкой. Право отпускаем:
    // иначе несостоявшаяся отправка запирала бы подсказку на час — ровно та
    // тишина, ради устранения которой тикет 09 и делался.
    await releaseSilentHint(identity);
  }
  return delivered;
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
  /** Meta строки клиента: по ней реплику в ленте сверяют с апдейтом Telegram. */
  const inboundMeta = {
    telegram_update_id: update.update_id,
    telegram_message_id: message.message_id,
  };

  // Если есть text — нормальный путь. Caption приравниваем к text (фото со
  // словами «нужен ChatGPT» — нормальный продуктовый кейс).
  const rawText =
    typeof message.text === 'string' && message.text.length > 0
      ? message.text
      : typeof message.caption === 'string' && message.caption.trim().length > 0
        ? message.caption
        : null;

  // Per-identity rate-limit — ДО любой ветки (аудит 2026-08-10). Раньше он
  // стоял ниже, и `/start` (включая `ref_`/`link_`), `/menu` и медиа шли мимо:
  // обходной путь был дороже лимитируемого — `/start` upsert'ит `users` и
  // `conversations` и пишет ДВЕ строки в `messages`.
  //
  // Бакета ТРИ, и это принципиально: у каждого входа свой кошелёк, поэтому один
  // не может уморить другой голодом.
  //   - `telegram-start` — `/start`. `/start link_<token>` это обязательный шаг
  //     оплаты для пришедшего с сайта (без `telegram_id` `confirm_order`
  //     платёжную ссылку не выдаёт), его нельзя ронять чужим трафиком;
  //   - `telegram-media` — фото/видео/голос. Telegram шлёт по апдейту на КАЖДОЕ
  //     фото альбома, так что общий бакет альбом бы и выел — вместе с кнопкой
  //     «Поддержка», которая платит из того же кошелька;
  //   - `telegram` — текст и callback-кнопки, как и было до аудита.
  // Контакт (reply-кнопка request_contact, тикет 06) — шаг оплаты крупного
  // заказа: считаем его текстовым бакетом `telegram`, а не медиа — альбом
  // скриншотов не должен выедать возможность поделиться номером.
  const kind =
    rawText === null
      ? message.contact
        ? 'contact'
        : 'media'
      : isStartCommand(rawText)
        ? 'start'
        : 'text';
  const bucket =
    kind === 'start' ? 'telegram-start' : kind === 'media' ? 'telegram-media' : 'telegram';
  const rlIdentity = String(telegramUserId ?? chatId);
  const rl = await checkRateLimit(bucket, rlIdentity);
  if (!rl.allowed) {
    log.warn({ event: 'telegram.rate_limited', updateId: update.update_id, chatId, kind });
    // Отвечаем ТОЛЬКО на текст. На медиа бот и в норме молчит (при выключенном
    // BOT_AI_ENABLED — по контракту), а альбом из десяти фото сверх лимита иначе
    // вернулся бы десятью одинаковыми окриками.
    if (rawText !== null) {
      await sendSafely(
        chatId,
        'Слишком много сообщений подряд. Подожди минутку и напиши снова — я никуда не денусь.',
        update.update_id,
      );
    }
    return;
  }

  if (kind === 'contact') {
    log.info({
      event: 'telegram.update.handled',
      updateId: update.update_id,
      chatId,
      telegramUserId,
      kind: 'contact',
    });
    await handleContactMessage(update, message);
    return;
  }

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
      // ⚠️ Альбом схлопываем ДО похода в БД: Telegram шлёт апдейт на КАЖДОЕ
      // фото, а путь ниже делает upsert клиента, поиск разговора и чтение
      // режима. Десять кадров = десять таких троек в процессе, который заодно
      // принимает вебхуки платежей, и десять строк «[фото]» в переписке.
      // Второе-десятое фото молчат при любом флаге: первое уже получило ответ
      // (помощника, оператора или подсказку) и оставило след в ленте.
      if (message.media_group_id && !(await claimMediaGroup(String(message.media_group_id)))) {
        return;
      }

      // Режим разговора читается ВСЕГДА, а не только при включённом помощнике
      // (crm-serious-fixes, тикет 01): вложение клиента, которому отвечает
      // оператор, — такое же обращение, как текст. Модуль ставит маркер и
      // пишет «[фото]» сам; в сессии помощника честно говорит, что читает
      // только текст.
      const ctx = await persistInbound(update, message);
      if (ctx) {
        const outcome = await routeSupportIncoming(ctx, chatId, update, message, {
          text: '',
          kind: 'media',
          mediaKind,
          userMeta: inboundMeta,
        });
        if (outcome.status !== 'not_in_session' && outcome.status !== 'state_unavailable') {
          return;
        }
        // Вне разговора след вложения пишет бот (тикет 04): иначе оператор,
        // попросивший скриншот, не видит в ленте, что клиент его прислал.
        await safeAppendMessage(
          ctx,
          'user',
          supportMediaContent(mediaKind),
          inboundMeta,
          update.update_id,
        );
      }
      // При включённом BOT_AI_ENABLED — прежний шаблонный ответ; при
      // выключенном (тикет 09) — подсказка с кнопкой «Поддержка».
      if (serverEnv.BOT_AI_ENABLED) {
        await sendSafely(chatId, MEDIA_REPLY[mediaKind], update.update_id);
      } else {
        // Тикет 09: молчания больше нет — уходит подсказка с кнопкой
        // «Поддержка». Дедуп обязателен: человек, которому не ответили по
        // делу, шлёт несколько скриншотов подряд.
        const hinted = await sendSilentHint(
          chatId,
          rlIdentity,
          SILENT_MEDIA_HINT,
          update.update_id,
        );
        // ⚠️ Подсказку на вложение в переписку НЕ пишем, в отличие от текста.
        // Флаг «ждём описание проблемы» читается из ПОСЛЕДНЕЙ строки бота:
        // клиент нажал «Поддержка», прислал скриншот, и строка подсказки
        // затёрла бы флаг — его текстовое описание обращением уже не стало бы.
        // Фото — обычный способ пожаловаться (скриншот отказа оплаты), и такой
        // клиент так же невидим без уведомления. Самого файла персоналу не шлём:
        // в текст уходит только пометка о типе вложения.
        if (message.from) {
          await notifyStaffAboutInboundMessage({
            telegramId: message.from.id,
            firstName: message.from.first_name,
            lastName: message.from.last_name,
            username: message.from.username,
            text: supportMediaContent(mediaKind),
            updateId: update.update_id,
          });
        }
        // Событие остаётся: оно меряет, сколько людей приходит в бота за тем,
        // чего он при выключенном AI не умеет. `hinted` отделяет прежнюю
        // тишину от нынешней подсказки.
        trackServer({
          name: 'bot_text_ignored',
          telegramId: telegramUserId ? String(telegramUserId) : null,
          props: { kind: 'media', hinted },
          eventKey: `tg-${update.update_id}-${telegramUserId ?? 'anon'}-ignored`,
        });
      }
      return;
    }
    // edited_message без текста, system-сообщения и т.п. — тихо игнорируем.
    log.warn({ event: 'telegram.update.ignored', updateId: update.update_id, kind: 'no_text' });
    return;
  }

  const text = rawText;
  const isFromCaption = !message.text && message.caption !== undefined;
  const captionMediaKind = isFromCaption ? detectMediaKind(message) : null;
  // Кадр альбома с подписью занимает альбом, чтобы остальные кадры не легли в
  // ленту вторыми строками «[фото]». Сам кадр обрабатывается в любом случае —
  // подпись терять нельзя. Если альбом уже занят кадром без подписи (он пришёл
  // раньше и оставил «[фото]»), подпись ложится без второй пометки.
  const albumAlreadyLogged =
    message.media_group_id !== undefined &&
    !(await claimMediaGroup(String(message.media_group_id)));
  // Что лечь в переписку и уйти оператору: подпись к вложению — вместе с
  // плейсхолдером («[фото] вот скриншот»). Без него оператор не узнал бы, что
  // клиент прислал скриншот, а видел бы только подпись (тикет 04). Команды,
  // меню и AI-диалог продажи получают `text` как раньше.
  const threadText =
    captionMediaKind && !albumAlreadyLogged ? supportMediaContent(captionMediaKind, text) : text;
  if (isFromCaption) {
    const mediaKind = captionMediaKind;
    log.info({
      event: 'telegram.update.handled',
      updateId: update.update_id,
      chatId,
      telegramUserId,
      kind: 'media_with_caption',
      mediaType: mediaKind,
    });
  }

  if (isStartCommand(text)) {
    await handleStartCommand(update, message, chatId, text);
    return;
  }

  // /privacy — ссылки на политику и соглашение (требование Telegram к ботам).
  // До флага BOT_AI_ENABLED: работает при выключенном AI-диалоге, как /start.
  if (isPrivacyCommand(text)) {
    await handlePrivacyCommand(chatId, update.update_id);
    return;
  }

  // /menu — открыть кнопочный каталог в любой момент (зеркало кнопки «Выбрать
  // сервис» на сайте). Навигация без AI — обрабатываем до роутера/агента.
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
      trackServer({
        name: 'bot_text_ignored',
        telegramId: telegramUserId ? String(telegramUserId) : null,
        props: { kind: 'menu' },
        eventKey: `tg-${update.update_id}-${telegramUserId ?? 'anon'}-ignored`,
      });
      return;
    }
    log.info({ event: 'telegram.menu', chatId, telegramUserId });
    await showCatalogList(chatId, undefined, update.update_id);
    return;
  }

  // /support — обращение в поддержку (interim-handoff оператору). Как и всё
  // остальное — под лимитом, взятым в начале функции: inline-форма
  // `/support <текст>` сразу шлёт человеку, спам недопустим.
  // Нажатие постоянной reply-кнопки «Написать в поддержку» шлёт свой лейбл текстом
  // без префикса — extractSupportInline вернёт null, и handleSupportCommand уйдёт в
  // двухшаговый флоу (попросит описать проблему), а не отправит пустое обращение.
  if (
    text === '/support' ||
    text.startsWith('/support ') ||
    text.startsWith('/support@') ||
    text === SUPPORT_BUTTON
  ) {
    const ctx = await persistInbound(update, message);
    if (!ctx) {
      // БД недоступна — состояние читать нечем; уводим в сегодняшний флоу.
      await handleSupportCommand(update, message, chatId, text, { ctx: null });
      return;
    }
    // Команду как реплику пишем сами и ДО чтения режима: ответ бота
    // (приветствие, «обращение у оператора», «опишите проблему») обязан лечь в
    // ленту после неё. Модуль пишет только то, что уйдёт модели, а «/support»
    // ей не нужен. Текст после команды запишет модуль или флоу к человеку.
    await safeAppendMessage(ctx, 'user', '/support', inboundMeta, update.update_id);
    // Режим читается при ЛЮБОМ флаге (crm-serious-fixes, тикет 01): модуль сам
    // знает, доступен ли помощник. Разговор у оператора получает «обращение уже
    // у оператора», а не «опишите проблему» поверх идущего диалога — иначе
    // описание тихо легло бы в обращение без ответа клиенту.
    const opened = await openSupportFromBot(ctx, chatId, update.update_id, message.from, 'command');
    if (opened.status === 'unavailable') {
      // Помощника нет (флаг, ключ) или состояние не прочитать — сегодняшний
      // двухшаговый флоу к человеку, он умеет работать без режима.
      await handleSupportCommand(update, message, chatId, text, { ctx, commandRecorded: true });
      return;
    }
    if (opened.status === 'already_open') {
      // Приветствие не повторяем, но и не молчим: второй `/support` подряд
      // иначе возвращал бы пустоту.
      await sendSafely(chatId, SUPPORT_ALREADY_OPEN, update.update_id);
    }
    // Однострочная форма «/support <текст>» — это уже первое сообщение
    // сессии (или продолжение обращения у оператора — маркер ставит модуль):
    // заставлять человека повторять то, что он только что написал, значит
    // терять его на лишнем шаге.
    //
    // ⚠️ Разбор — общей `extractSupportInline`, а не своим регэкспом: сюда
    // попадает и нажатие старой reply-кнопки, чей ЛЕЙБЛ («Написать в
    // поддержку») префикса `/support` не имеет вовсе. Наивная обрезка
    // префикса отдавала бы модели подпись кнопки как вопрос клиента — и
    // сжигала ход из суточного лимита на ответ самой себе.
    const inline = extractSupportInline(text);
    if (inline) {
      await routeSupportIncoming(ctx, chatId, update, message, {
        text: inline,
        kind: 'text',
        userMeta: inboundMeta,
      });
    }
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
    // ⚠️ Реплику клиента пишет МОДУЛЬ поддержки — только он знает режим и
    // ставит маркер обращения в `operator`. Бот пишет её сам лишь когда модуль
    // сказал «сессии нет».
    //
    // Модуль зовётся ПРИ ЛЮБОМ ФЛАГЕ (crm-serious-fixes, тикет 01): помощник —
    // выключатель модели, а не учёта. Пока здесь стояло `if (флаг)`, при
    // выключенном помощнике ответ клиента оператору ложился в переписку без
    // маркера: панель считала разговор отвеченным, клиент получал «нажмите
    // кнопку», а через сутки крон писал ждущему «оператор завершил обращение».
    const outcome = await routeSupportIncoming(ctx, chatId, update, message, {
      text: threadText,
      kind: 'text',
      userMeta: inboundMeta,
    });
    if (outcome.status === 'operator_leads') {
      // Разговор ведёт человек: он ответит из панели. Бот молчит, чтобы не
      // вклиниваться в чужой диалог второй репликой, и персонал не зовёт —
      // модуль уже пингнул его со своим дедупом по БД.
      return;
    }
    if (outcome.status !== 'not_in_session' && outcome.status !== 'state_unavailable') {
      return;
    }
    // Сессии нет или состояние не прочитать — дальше бот работает как без
    // помощника, и реплику пишет сам.
    await safeAppendMessage(ctx, 'user', threadText, inboundMeta, update.update_id);

    // Pending-state читаем ОДИН раз (meta последнего assistant-сообщения) и
    // диспатчим: ожидание описания для /support ИЛИ ожидание суммы для
    // custom-amount сервиса. Оба — быстрый путь мимо AI.
    const pendingMeta = await readPendingMeta(ctx.conversationId, update.update_id);

    // Флоу поддержки: бот ранее попросил описать проблему — этот текст пересылаем
    // оператору.
    if (await tryHandlePendingSupport(ctx, message, chatId, threadText, pendingMeta, update.update_id)) {
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
    // Тикет 09: раньше здесь бот замолкал, и человек, написавший «помогите»,
    // уходил в пустоту — обращение не появлялось нигде, в том числе в панели.
    // Теперь уходит одна фраза с кнопкой «Поддержка». Обращение по-прежнему
    // создаётся ТОЛЬКО нажатием (правило владельца) — подсказка его не создаёт.
    //
    // Сюда попадает и неизвестная команда (`/foo`): она тоже заканчивалась
    // тишиной, а человек, промахнувшийся мимо команды, тем более нуждается в
    // указателе. Известные команды и кнопки до этой точки не доходят.
    const hinted = await sendSilentHint(chatId, rlIdentity, SILENT_TEXT_HINT, update.update_id);
    // ⚠️ Персонал узнаёт о ЛЮБОМ написавшем, а не только о нажавшем кнопку
    // (решение владельца 2026-09-09). Правило В3 не меняется — обращение
    // по-прежнему создаётся кнопкой; меняется видимость: человек, написавший
    // «помогите», раньше не попадал никуда, кроме переписки, которую никто не
    // открывал. Дедуп (30 минут на клиента) и доставка — внутри модуля.
    if (message.from) {
      await notifyStaffAboutInboundMessage({
        telegramId: message.from.id,
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username,
        // То же, что легло в ленту: подпись к фото — с пометкой вложения.
        text: threadText,
        updateId: update.update_id,
      });
    }
    // Подсказку кладём в переписку — иначе лента обращения в панели (тикет 10)
    // показывала бы вопрос клиента без единого ответа, хотя ответ был.
    if (hinted && ctx) {
      await safeAppendMessage(
        ctx,
        'assistant',
        SILENT_TEXT_HINT,
        { source: 'silent_hint' },
        update.update_id,
      );
    }
    // `len` вместо текста — переписка в аналитику не тянется (PII).
    trackServer({
      name: 'bot_text_ignored',
      telegramId: telegramUserId ? String(telegramUserId) : null,
      props: { kind: 'text', len: text.length, hinted },
      eventKey: `tg-${update.update_id}-${telegramUserId ?? 'anon'}-ignored`,
    });
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

  // Одна точка на все inline-кнопки: какая именно — в props.button. Отдельными
  // именами событий их делать нельзя — кнопки меняются, а имена событий вечны.
  //
  // ПОСЛЕ анти-абьюз-гейта, а не до (инвариант 9): иначе зажатая кнопка — тот
  // самый кейс, ради которого лимит на callback'и и вводили — писала бы строку
  // в БД на каждое нажатие, хотя пользователю уже отвечено «слишком много».
  //
  // ВНИМАНИЕ: сюда попадают только callback-кнопки. Нажатия url-кнопок («Сайт»,
  // канал, сторы, ссылка оплаты) Telegram не сообщает вообще — их в аналитике
  // нет и быть не может.
  trackServer({
    name: 'bot_menu_click',
    telegramId: cb.from?.id ? String(cb.from.id) : null,
    props: parts[1] ? { button: action, slug: parts[1] } : { button: action },
    eventKey: `tg-${updateId}-${cb.from?.id ?? 'anon'}-cb`,
  });

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
    case 'support': {
      // `support:finish` — кнопка «Завершить» под ответом помощника; голый
      // `support` — вход в поддержку из стартового меню.
      if (parts[1] === 'finish') {
        const ctx = await resolveCallbackContext(cb, updateId);
        if (ctx) {
          await finishSupportFromBot(ctx, chatId, updateId, cb.from?.id ?? chatId);
        }
        return;
      }
      // Общий вход по кнопке (support-entry.ts): им же пользуется «Другое»
      // в опросах воронки — дверь в поддержку одна (правило В3).
      await openSupportEntry(cb, chatId, updateId);
      return;
    }
    case 'fb':
      // Воронка обратной связи: ответы на опросы, оценка, отписка. Работает
      // независимо от BOT_AI_ENABLED — это кнопки под сообщениями воронки,
      // а не каталог.
      await handleFunnelCallback(cb, chatId, parts, updateId);
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
