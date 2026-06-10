import 'server-only';

import { cookies } from 'next/headers';

const COOKIE_NAME = 'session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 дней (docs/web-chat.md)

/**
 * web_session_id из httpOnly-cookie `session`, создаётся при первом визите
 * (UUID v4). Идентификация веб-юзера без регистрации — см. docs/web-chat.md
 * §«Идентификация пользователя». Запись `users(web_session_id)` создаётся
 * только при первом сообщении (в /api/chat), не при открытии страницы.
 */
export async function getOrCreateWebSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE_NAME)?.value;
  if (existing) return existing;

  const id = crypto.randomUUID();
  store.set(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return id;
}

/**
 * Читает web_session_id из cookie БЕЗ создания (для GET-эндпоинтов вроде
 * восстановления истории — новый посетитель просто получит пусто).
 */
export async function readWebSessionId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}
