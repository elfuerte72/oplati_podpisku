import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getDb, getWebSessionProfile } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { readWebSessionId } from '@/lib/chat/session';
import { getBotUsername } from '@/lib/telegram/bot';
import { cabinetDeepLink } from '@/lib/telegram/deep-links';
import { telegramBotLink } from '@/lib/telegram/links';

/**
 * GET /api/profile — профиль текущей веб-сессии для правой панели:
 * имя (display_name из Telegram после привязки), статус привязки и реальная
 * статистика покупок из orders (оплаченные: paid/in_fulfillment/completed).
 * Плюс две ссылки на бота: `supportUrl` (мобильный баннер «Продолжить в
 * Telegram») и `cabinetUrl` (кнопка «Личный кабинет» — Mini App). Read-only:
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
 * Ссылки на бота: `supportUrl` (открыть бота с сайта) и `cabinetUrl` (Mini App-
 * кабинет). Best-effort: нет токена бота / getMe упал → оба null, кнопки просто
 * не покажутся. Username кэшируется в bot.ts на жизнь инстанса, так что getMe
 * зовётся редко — обе ссылки берут его из одного вызова.
 *
 * Deep-link `?start=site` уводит на /start (приветствие + меню). Без параметра
 * Telegram открывает бота на последней команде — например неработающем /menu.
 */
async function resolveBotLinks(): Promise<{
  supportUrl: string | null;
  cabinetUrl: string | null;
}> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { supportUrl: null, cabinetUrl: null };
  try {
    const username = await getBotUsername();
    return {
      supportUrl: telegramBotLink(username, 'site'),
      cabinetUrl: cabinetDeepLink(username),
    };
  } catch (err) {
    log.warn({ event: 'profile.bot_links_failed', err });
    return { supportUrl: null, cabinetUrl: null };
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    // Независимы — параллелим, чтобы cold-start getMe не задерживал чтение сессии.
    const [links, webSessionId] = await Promise.all([resolveBotLinks(), readWebSessionId()]);
    if (!webSessionId) {
      return NextResponse.json({ ok: true, profile: EMPTY, ...links }, { status: 200 });
    }
    const profile = await getWebSessionProfile(getDb(), webSessionId);
    return NextResponse.json({ ok: true, profile, ...links }, { status: 200 });
  } catch (err) {
    log.error({ event: 'profile.failed', err });
    Sentry.captureException(err, { tags: { source: 'profile' } });
    return NextResponse.json(
      { ok: false, profile: EMPTY, supportUrl: null, cabinetUrl: null },
      { status: 200 },
    );
  }
}
