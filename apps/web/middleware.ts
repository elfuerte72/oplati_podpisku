import { NextResponse, type NextRequest } from 'next/server';

import { parseReferralCode } from '@oplati/types';

/**
 * Захват реферальной ссылки на вебе: `https://<site>/?ref=<code>`.
 *
 * Лендинг — RSC и не может ставить cookie при рендере, поэтому ловим `?ref=`
 * здесь (middleware) и кладём в httpOnly-cookie `ref`. Cookie потребляется при
 * создании веб-пользователя в `/api/chat` (см. consumeRefCookie). First-touch:
 * существующий `ref`-cookie не перезаписываем (первая ссылка побеждает, как и
 * immutable-referrer). Валидация формата — `parseReferralCode` (Edge-safe: zod,
 * без node:crypto). Невалидный код игнорируем молча.
 *
 * Сам захват реферера дополнительно гейтится `REFERRAL_ENABLED` уже на стороне
 * `/api/chat` — тут флаг не читаем (env в middleware-рантайме можно не иметь),
 * лишний cookie без включённой программы безвреден.
 */

const REF_COOKIE = 'ref';
const REF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 дней

export function middleware(req: NextRequest): NextResponse {
  const code = parseReferralCode(req.nextUrl.searchParams.get('ref'));
  if (!code || req.cookies.has(REF_COOKIE)) {
    return NextResponse.next();
  }
  const res = NextResponse.next();
  res.cookies.set(REF_COOKIE, code, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REF_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

// Только страницы: пропускаем api, статику Next и favicon — там `?ref=` не нужен.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
