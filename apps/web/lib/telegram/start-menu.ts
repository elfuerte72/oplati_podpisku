import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { InlineKeyboard } from 'grammy';

import { getDb, LINK_TOKEN_PREFIX, resolveReferralCode } from '@oplati/db';
import { GREETING } from '@oplati/agent';
import { parseReferralCode, REFERRAL_DEEPLINK_PREFIX } from '@oplati/types';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { captureReferralForUser } from '@/lib/cabinet/referral-capture';
import { miniAppUrl, paymentInstructionUrl, siteUrl } from '@/lib/deployment-url';
import { serverEnv } from '@/lib/env.server';
import { trackServer } from '@/lib/analytics/track';
import { childLogger } from '@/lib/logger';

import { handleLinkDeepLink } from './link-flow';
import { persistInbound, safeAppendMessage } from './persist';
import { sendSafely } from './send';
import {
  START_APP_BUTTON,
  START_CHANNEL_BUTTON,
  START_HOWTO_BUTTON,
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
    eventKey: `tg-${update.update_id}-start`,
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
  return new InlineKeyboard()
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
