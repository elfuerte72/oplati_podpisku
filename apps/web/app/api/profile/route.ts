import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, getWebSessionProfile } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';
import { getBotUsername } from '@/lib/telegram/bot';

/**
 * GET /api/profile — профиль текущей веб-сессии для правой панели:
 * имя (display_name из Telegram после привязки), статус привязки и реальная
 * статистика покупок из orders (оплаченные: paid/in_fulfillment/completed).
 * Также `supportUrl` — ссылка на бота для кнопки «Поддержка». Read-only:
 * cookie и пользователя не создаёт; новому посетителю — нули.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 10;

const log = childLogger('profile');

const EMPTY = {
  displayName: null,
  telegramLinked: false,
  ordersCount: 0,
  totalSpentKopecks: 0,
};

/**
 * Ссылка на бота для кнопки «Telegram» (открыть бота с сайта). Best-effort:
 * нет токена бота / getMe упал → null, кнопка просто не покажется. Username
 * кэшируется в bot.ts на жизнь инстанса, так что getMe зовётся редко.
 *
 * Deep-link `?start=site` уводит на /start (приветствие + меню). Без параметра
 * Telegram открывает бота на последней команде — например неработающем /menu.
 */
async function resolveSupportUrl(): Promise<string | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const username = await getBotUsername();
    return `https://t.me/${username}?start=site`;
  } catch (err) {
    log.warn({ event: 'profile.support_url_failed', err });
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    // Независимы — параллелим, чтобы cold-start getMe не задерживал чтение сессии.
    const [supportUrl, webSessionId] = await Promise.all([
      resolveSupportUrl(),
      readWebSessionId(),
    ]);
    if (!webSessionId) {
      return NextResponse.json({ ok: true, profile: EMPTY, supportUrl }, { status: 200 });
    }
    const profile = await getWebSessionProfile(getDb(), webSessionId);
    return NextResponse.json({ ok: true, profile, supportUrl }, { status: 200 });
  } catch (err) {
    log.error({ event: 'profile.failed', err });
    Sentry.captureException(err, { tags: { source: 'profile' } });
    return NextResponse.json({ ok: false, profile: EMPTY, supportUrl: null }, { status: 200 });
  }
}
