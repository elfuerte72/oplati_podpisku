import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { InlineKeyboard } from 'grammy';

import { getDb, getUserTelegramId, LINK_TOKEN_PREFIX, resolveReferralCode } from '@oplati/db';
import { GREETING } from '@oplati/agent';
import { parseReferralCode, REFERRAL_DEEPLINK_PREFIX } from '@oplati/types';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { captureReferralForUser } from '@/lib/cabinet/referral-capture';
import { miniAppUrl, paymentInstructionUrl, siteUrl } from '@/lib/deployment-url';
import { serverEnv } from '@/lib/env.server';
import { trackServer } from '@/lib/analytics/track';
import { childLogger } from '@/lib/logger';

import { handleLinkDeepLink } from './link-flow';
import { handleSupportCommand } from './support-flow';
import { SUPPORT_START_PAYLOAD } from './links';
import { isSupportAiEnabled, openSupportFromBot, resetSupportOnStart } from './support-session';
import { persistInbound, safeAppendMessage, type PersistContext } from './persist';
import { sendSafely } from './send';
import {
  REFERRAL_PARTNER_JOINED_TEXT,
  REFERRAL_SELF_LINK_TEXT,
  REFERRAL_WELCOME_TEXT,
  START_APP_BUTTON,
  START_CHANNEL_BUTTON,
  START_HOWTO_BUTTON,
  START_REVIEWS_BUTTON,
  START_SITE_BUTTON,
  START_SUPPORT_BUTTON,
  START_VPN_BUTTON,
  TELEGRAM_CHANNEL_URL,
} from './templates';

/**
 * `/start`: приветствие GREETING + inline-меню, deep-link'и `link_<token>`
 * (привязка веб-сессии → link-flow) и `ref_<code>` (реферальный захват)
 * (выделено из handle-update.ts при распиле M-10, поведение 1:1).
 */

const log = childLogger('telegram-bot');


/**
 * Команда `/start` (с любыми deep-link payload'ами после пробела): upsert
 * пользователя и conversation, append двух сообщений (user `/start` +
 * assistant GREETING), отправка GREETING с inline-меню.
 */
export async function handleStartCommand(
  update: TelegramUpdate,
  message: TelegramMessage,
  chatId: number,
  text: string,
): Promise<void> {
  log.info({
    event: 'telegram.start',
    chatId,
    telegramUserId: message.from?.id,
    languageCode: message.from?.language_code,
  });

  // С чем пришёл: привязка с сайта, реферальная ссылка, кабинет или просто так.
  // Пишем ДО ветвлений — часть из них возвращается раньше.
  const startPayloadRaw = text.startsWith('/start ') ? text.slice('/start '.length).trim() : '';
  trackServer({
    name: 'bot_start',
    telegramId: message.from?.id ? String(message.from.id) : null,
    props: { payload_kind: classifyStartPayload(startPayloadRaw) },
    eventKey: `tg-${update.update_id}-${message.from?.id ?? 'anon'}-start`,
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
  // Что сказать после приветствия про реферальную ссылку (см. attachReferral).
  let referralFeedback: ReferralFeedback = 'none';
  if (ctx) {
    if (referredBy) {
      referralFeedback = await attachReferral(ctx, referredBy, update.update_id);
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

    // Deep-link `?start=support` — третья дверь в поддержку рядом с кнопкой и
    // командой: по ней ведут Mini App и сайт, у которых своего канала связи с
    // клиентом нет. Без помощника (флаг, ключ, непрочитанное состояние) —
    // сегодняшний флоу к человеку, как по кнопке: ссылка обещала поддержку,
    // а не меню.
    if (startPayloadRaw.toLowerCase() === SUPPORT_START_PAYLOAD) {
      await sendSafely(chatId, GREETING, update.update_id, buildStartMenuKeyboard());
      if (isSupportAiEnabled()) {
        const opened = await openSupportFromBot(ctx, chatId, update.update_id, message.from, 'deeplink');
        if (opened.status !== 'unavailable') return;
      }
      await handleSupportCommand(update, message, chatId, '/support');
      return;
    }
    if (isSupportAiEnabled()) {
      // ⚠️ Любой другой `/start` СБРАСЫВАЕТ помощника — молча. Это выход из
      // сессии для человека, который «залип» в разговоре: он видит привычное
      // меню, а не продолжение переписки. Разговор, который ведёт ОПЕРАТОР, не
      // трогается: удержание снимает человек, а не команда клиента.
      await resetSupportOnStart(ctx, chatId, update.update_id, message.from?.id ?? chatId);
    }
  }

  await sendSafely(chatId, GREETING, update.update_id, buildStartMenuKeyboard());
  if (referredBy && referralFeedback !== 'none') {
    await sendReferralFeedback(chatId, referralFeedback, referredBy, update.update_id);
  }
}

/**
 * Что показать после приветствия по итогам `/start ref_`: `attached` — друг
 * только что закреплён за партнёром, `self_link` — человек открыл свою же
 * ссылку, `none` — ничего не изменилось (уже закреплён, есть покупки, сбой).
 */
type ReferralFeedback = 'none' | 'attached' | 'self_link';

/**
 * Закрепление реферера по `/start ref_<code>` и выбор обратной связи.
 *
 * Новая строка: реферер проставлен уже INSERT'ом (`getOrCreateUserByTelegramId`),
 * поздний захват ей не нужен — раньше он звался и для неё, тратя два запроса на
 * гарантированный `already_set`. Существующая строка (человек раньше открыл
 * мини-апп кнопкой ☰ или пришёл без ссылки): `captureReferralForUser` —
 * идемпотентно, с антифрод-гейтом по покупкам.
 *
 * ⚠️ Свою ссылку партнёры открывают регулярно — «проверить, работает ли».
 * До 2026-09-05 ответом было обычное приветствие, и проверка «показывала», что
 * ссылка сломана (разбор жалоб: три таких захода у одного партнёра за месяц при
 * исправном захвате). Теперь это отдельный исход с подсказкой.
 */
async function attachReferral(
  ctx: PersistContext,
  referrerId: string,
  updateId: number,
): Promise<ReferralFeedback> {
  if (referrerId === ctx.userId) {
    log.info({ event: 'telegram.referral.self_link', updateId });
    return 'self_link';
  }
  if (ctx.userCreated) {
    log.info({ event: 'telegram.referral.attached', updateId, via: 'insert' });
    return 'attached';
  }
  const outcome = await captureReferralForUser({
    userId: ctx.userId,
    referrerId,
    source: 'bot_start',
  });
  if (outcome === 'set') {
    log.info({ event: 'telegram.referral.attached', updateId, via: 'late_capture' });
    return 'attached';
  }
  if (outcome === 'self_link') return 'self_link';
  return 'none';
}

/**
 * Обратная связь ПОСЛЕ приветствия: другу — что приглашение сработало (или что
 * ссылка его собственная), партнёру — DM о новом друге. Всё best-effort:
 * приветствие уже ушло, и ни один сбой здесь не должен долететь до webhook'а.
 * Партнёру не называем ни имя, ни id друга — чужие данные ему не показываем;
 * о каждом закреплении сообщается ровно один раз по построению
 * (`referred_by` immutable, повтор даёт `already_set` → 'none').
 */
async function sendReferralFeedback(
  chatId: number,
  feedback: Exclude<ReferralFeedback, 'none'>,
  referrerId: string,
  updateId: number,
): Promise<void> {
  if (feedback === 'self_link') {
    await sendSafely(chatId, REFERRAL_SELF_LINK_TEXT, updateId);
    return;
  }
  await sendSafely(chatId, REFERRAL_WELCOME_TEXT, updateId);
  try {
    const partnerTelegramId = await getUserTelegramId(getDb(), referrerId);
    if (!partnerTelegramId) {
      // Партнёр — веб-строка без Telegram: писать ему некуда, увидит в кабинете.
      log.info({ event: 'telegram.referral.partner_no_telegram', updateId });
      return;
    }
    const delivered = await sendSafely(Number(partnerTelegramId), REFERRAL_PARTNER_JOINED_TEXT, updateId);
    log.info({ event: 'telegram.referral.partner_notified', updateId, delivered });
  } catch (err) {
    log.warn({ event: 'telegram.referral.partner_notify_failed', updateId, err });
    Sentry.captureException(err, { tags: { source: 'telegram.referral' } });
  }
}

/**
 * Inline-меню под приветствием /start (заменило постоянную reply-клавиатуру
 * 2026-07-02): Mini App (каталог + оплата + карта + партнёрка) — главный флоу,
 * поддержка — существующий callback `support`, канал — url-кнопка (канал создан
 * 2026-07-10), VPN — выдача ссылки-подписки Remnawave (vpn-flow.ts). Тексты старых reply-кнопок
 * («Выбрать сервис» / «Написать в поддержку») по-прежнему перехватываются в
 * handleTelegramUpdate — у существующих пользователей клавиатура осталась
 * раскрытой.
 */
export function buildStartMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .webApp(START_APP_BUTTON, miniAppUrl())
    .row()
    // ?src=tg — анти-петля: сайт видит, что визит из бота, и не показывает
    // мобильный баннер «Продолжить в Telegram» (MobileTelegramBanner.tsx).
    .url(START_SITE_BUTTON, `${siteUrl()}/?src=tg`)
    .row()
    .url(START_HOWTO_BUTTON, paymentInstructionUrl())
    .row()
    .text(START_SUPPORT_BUTTON, 'support')
    .row()
    .text(START_VPN_BUTTON, 'vpn')
    .row()
    .url(START_CHANNEL_BUTTON, TELEGRAM_CHANNEL_URL);
  // «Отзывы» — url-кнопка на живой чат отзывов (трек retention-funnel, тикет 02).
  // Env не задан → кнопки нет: чат — внешний ресурс, и мёртвая ссылка хуже
  // отсутствующей (fail-quiet, прецедент — необязательные кнопки меню).
  const reviewsUrl = serverEnv.REVIEWS_CHAT_URL;
  if (reviewsUrl) {
    keyboard.row().url(START_REVIEWS_BUTTON, reviewsUrl);
  }
  return keyboard;
}

/**
 * Резолв реферера из payload `/start ref_<code>`. Best-effort: неизвестный код
 * или сбой БД → `null` (захвата нет, приветствие всё равно уходит). Самореферал
 * дерево не меняет — существующий юзер попадает в ON CONFLICT и referred_by не
 * трогается; новый юзер своего кода ещё не имеет. Но ЗАХОД по своей ссылке
 * реален и получает отдельный ответ (`attachReferral`).
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
 * Во что превращается payload `/start <...>` в аналитике. Не сам payload:
 * в нём едет одноразовый токен привязки, а секретам в телеметрии не место.
 */
function classifyStartPayload(payload: string): string {
  if (!payload) return 'plain';
  const lower = payload.toLowerCase();
  if (lower.startsWith('link_')) return 'link';
  if (lower.startsWith('ref_')) return 'ref';
  if (lower.startsWith('cabinet')) return 'cabinet';
  return 'other';
}
