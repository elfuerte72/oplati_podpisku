import 'server-only';

import { cookies, headers } from 'next/headers';

import {
  findStaffById,
  findStaffByTelegramId,
  getDb,
  startStaffTotpEnrollment,
} from '@oplati/db';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { decidePanelHost } from './host';
import {
  authorizeSessionToken,
  type PanelActor,
  type SessionAuthResult,
} from './login';
import {
  PANEL_PENDING_TTL_SECONDS,
  PANEL_SESSION_TTL_SECONDS,
  signPanelToken,
  verifyPanelToken,
} from './token';

/**
 * Cookie-обвязка входа в панель: чтение «кто действует» и выдача/снятие
 * токенов. Вся логика решений живёт в `login.ts` — здесь только Next.
 */

const log = childLogger('panel.session');

/**
 * Имена cookie. На проде — с префиксом `__Host-`: он запрещает браузеру
 * принимать такую cookie с `Domain=`, то есть сосед по `*.oplatishka.com`
 * (или XSS на нём) не сможет подсунуть панели свою сессию. Префикс требует
 * `Secure`, поэтому в dev по http берётся имя без него — иначе браузер
 * отбрасывал бы cookie и вход не проверить локально.
 */
const SECURE_COOKIES = process.env.NODE_ENV === 'production';
const COOKIE_PREFIX = SECURE_COOKIES ? '__Host-' : '';

export const PANEL_SESSION_COOKIE = `${COOKIE_PREFIX}oplatishka_panel_session`;
export const PANEL_PENDING_COOKIE = `${COOKIE_PREFIX}oplatishka_panel_pending`;

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: SECURE_COOKIES,
    // `path: '/'` и отсутствие `domain` — требования префикса `__Host-`.
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Кто действует. `null` — не вошёл, отозван или сессия протухла: панель во всех
 * случаях ведёт на страницу входа, различать их пользователю незачем.
 *
 * ⚠️ Ходит в базу на КАЖДЫЙ вызов — это и есть механизм отзыва доступа
 * (таблицы сессий нет). Кэшировать нельзя: смысл именно в свежести `is_active`.
 */
export async function readPanelActor(): Promise<PanelActor | null> {
  const res = await authorizePanelRequest();
  return res.ok ? res.actor : null;
}

export async function authorizePanelRequest(): Promise<SessionAuthResult> {
  // Гейт по хосту дублируется здесь намеренно (второй эшелон к proxy.ts и
  // Traefik): сессия панели не должна считаться живой на публичном домене,
  // даже если маршрутизацию когда-нибудь настроят неверно.
  if (!(await isPanelHost())) return { ok: false, reason: 'no_session' };

  const store = await cookies();
  const token = store.get(PANEL_SESSION_COOKIE)?.value;

  const res = await authorizeSessionToken({
    token,
    secret: serverEnv.ADMIN_SESSION_SECRET ?? '',
    findStaffById: (id) => findStaffById(getDb(), id),
  });

  if (!res.ok && res.reason === 'not_configured') {
    // Панель без `ADMIN_SESSION_SECRET` не пускает никого — это авария конфига,
    // и её надо видеть, а не гадать, почему вход «не работает».
    log.error({ event: 'panel.session.not_configured' });
  }
  return res;
}

/** Промежуточный токен: первый фактор пройден, ждём код. Доступа не даёт. */
export async function setPanelPendingCookie(staffId: string): Promise<void> {
  const store = await cookies();
  store.set(
    PANEL_PENDING_COOKIE,
    signPanelToken({ purpose: 'pending', staffId }, requireSessionSecret()),
    cookieOptions(PANEL_PENDING_TTL_SECONDS),
  );
}

export async function readPanelPendingCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(PANEL_PENDING_COOKIE)?.value;
}

/** Полный вход. Промежуточный токен гасим — он больше не нужен. */
export async function setPanelSessionCookie(staffId: string): Promise<void> {
  const store = await cookies();
  store.set(
    PANEL_SESSION_COOKIE,
    signPanelToken({ purpose: 'session', staffId }, requireSessionSecret()),
    cookieOptions(PANEL_SESSION_TTL_SECONDS),
  );
  store.delete(PANEL_PENDING_COOKIE);
}

export async function clearPanelCookies(): Promise<void> {
  const store = await cookies();
  store.delete(PANEL_SESSION_COOKIE);
  store.delete(PANEL_PENDING_COOKIE);
}

/**
 * Сотрудник, прошедший первый фактор, — для экрана привязки. Единственное
 * место, где панель читает `staff` мимо `PanelActor`: экрану нужен сам секрет,
 * чтобы показать его один раз. Дальше страницы он не уходит.
 */
export async function readPendingStaffForEnrollment(): Promise<
  { id: string; email: string; isActive: boolean; totpSecret: string | null; confirmed: boolean } | null
> {
  const token = await readPanelPendingCookie();
  if (!token) return null;

  const pending = verifyPanelToken(token, serverEnv.ADMIN_SESSION_SECRET ?? '', {
    purpose: 'pending',
  });
  if (!pending.ok) return null;

  const staff = await findStaffById(getDb(), pending.staffId);
  if (!staff) return null;

  return {
    id: staff.id,
    email: staff.email,
    isActive: staff.isActive,
    totpSecret: staff.totpSecret,
    confirmed: staff.totpConfirmedAt !== null,
  };
}

/**
 * Запрос пришёл на хост панели? Решение общее с `proxy.ts`; на проде
 * незаданный `PANEL_HOST` закрывает панель (fail-closed) и алертит — потеря
 * переменной не должна тихо выставлять панель на публичный домен.
 */
async function isPanelHost(): Promise<boolean> {
  const store = await headers();
  const decision = decidePanelHost({
    host: store.get('host'),
    expected: serverEnv.PANEL_HOST,
    isProduction: process.env.NODE_ENV === 'production',
  });
  if (decision === 'deny' && !serverEnv.PANEL_HOST) {
    log.error({ event: 'panel.session.host_not_configured' });
  }
  return decision !== 'deny';
}

function requireSessionSecret(): string {
  const secret = serverEnv.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set; panel login is disabled');
  return secret;
}

/** Зависимости входа, разложенные по репозиториям — чтобы роуты были тонкими. */
export const panelLoginDeps = {
  findStaffByTelegramId: (telegramId: string) => findStaffByTelegramId(getDb(), telegramId),
  findStaffById: (id: string) => findStaffById(getDb(), id),
  startTotpEnrollment: (input: { staffId: string; secret: string }) =>
    startStaffTotpEnrollment(getDb(), input),
};
