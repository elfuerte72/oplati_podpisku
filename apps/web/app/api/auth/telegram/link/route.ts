import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { createLinkToken, getDb, LINK_TOKEN_PREFIX } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { getOrCreateWebSessionId } from '@/lib/chat/session';
import { getBotUsername } from '@/lib/telegram/bot';

/**
 * POST /api/auth/telegram/link — начало привязки Telegram к веб-сессии.
 *
 * Создаёт одноразовый токен (TTL 10 минут) по cookie-сессии и возвращает
 * deep-link `https://t.me/<bot>?start=link_<token>`. Завершение привязки —
 * в обработчике `/start link_*` бота (lib/telegram/handle-update.ts),
 * прогресс клиент узнаёт поллингом `GET /api/auth/telegram/link/status`.
 *
 * Telegram-аккаунт здесь не подтверждается — личность фиксирует сам Telegram
 * фактом доставки `/start` от конкретного telegram_id. Токен случайный
 * (128 бит), одноразовый и короткоживущий.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('auth-telegram-link');
const dbLog = childLogger('db');

const FAIL_TEXT = 'Не получилось подготовить привязку. Попробуй ещё раз через минуту.';

export async function POST(): Promise<NextResponse> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    log.warn({ event: 'auth.telegram.link.disabled', reason: 'no_bot_token' });
    return NextResponse.json({ ok: false, error: 'unavailable', text: FAIL_TEXT }, { status: 200 });
  }

  try {
    const webSessionId = await getOrCreateWebSessionId();
    const [{ token, expiresAt }, botUsername] = await Promise.all([
      createLinkToken(getDb(), { webSessionId }, dbLog),
      getBotUsername(),
    ]);

    const url = `https://t.me/${botUsername}?start=${LINK_TOKEN_PREFIX}${token}`;
    log.info({ event: 'auth.telegram.link.token_issued' });

    return NextResponse.json(
      { ok: true, url, expiresAt: expiresAt.toISOString() },
      { status: 200 },
    );
  } catch (err) {
    log.error({ event: 'auth.telegram.link.failed', err });
    Sentry.captureException(err, { tags: { source: 'auth.telegram.link' } });
    return NextResponse.json({ ok: false, error: 'unavailable', text: FAIL_TEXT }, { status: 200 });
  }
}
