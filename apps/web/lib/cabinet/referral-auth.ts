import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrCreateUserByWebSessionId, getUserProfileById } from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getOrCreateWebSessionId } from '../chat/session.ts';
import { resolveCabinetUser } from './auth.ts';

/**
 * Резолв пользователя партнёрского кабинета. Две поверхности, один снапшот:
 *  - мини-апп: `initData` (подпись Telegram) → telegram-личность (всегда linked);
 *  - сайт: httpOnly-cookie `session` → web-юзер (linked зависит от привязки TG).
 *
 * Для веба строка `users` создаётся здесь (`getOrCreateUserByWebSessionId`):
 * открытие кабинета = намерение участвовать в программе, нужен id под выдачу
 * реферального кода. Вызывается ТОЛЬКО при включённом `REFERRAL_ENABLED`
 * (дремлющая программа строк не плодит — гейт в роуте).
 */

const log = childLogger('referral-cabinet.auth');
const dbLog = childLogger('db');

export type ReferralRequester = {
  userId: string;
  telegramLinked: boolean;
  surface: 'miniapp' | 'web';
  /** Ключ rate-limit'а: telegram_id (мини-апп) или web_session_id (сайт). */
  rateLimit: { name: 'telegram' | 'web-chat'; id: string };
};

export type ResolveReferralRequesterResult =
  | { ok: true; requester: ReferralRequester }
  | { ok: false; status: number; error: string };

/**
 * `initData` присутствует → путь мини-аппа (проверка подписи). Иначе — веб-сессия
 * по cookie. Возвращает дискриминированный результат с HTTP-статусом для роута.
 */
export async function resolveReferralRequester(
  initData: string | undefined | null,
): Promise<ResolveReferralRequesterResult> {
  // ── Мини-апп: initData ──
  if (initData) {
    const auth = await resolveCabinetUser(initData);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    return {
      ok: true,
      requester: {
        userId: auth.user.userId,
        telegramLinked: true,
        surface: 'miniapp',
        rateLimit: { name: 'telegram', id: auth.user.telegramId },
      },
    };
  }

  // ── Сайт: web-сессия по cookie ──
  try {
    const webSessionId = await getOrCreateWebSessionId();
    const db = getDb();
    // Захват реферера через веб удалён (2026-07-02): рефералы фиксируются ТОЛЬКО
    // при /start бота по deep-link `ref_<code>` — веб-юзер создаётся без реферера.
    const { id } = await getOrCreateUserByWebSessionId(
      db,
      { webSessionId, referredBy: null },
      dbLog,
    );
    const profile = await getUserProfileById(db, id);
    return {
      ok: true,
      requester: {
        userId: id,
        telegramLinked: profile?.telegramLinked ?? false,
        surface: 'web',
        rateLimit: { name: 'web-chat', id: webSessionId },
      },
    };
  } catch (err) {
    log.error({ event: 'referral.cabinet.auth.db_failed', err });
    Sentry.captureException(err, { tags: { source: 'referral.cabinet.auth' } });
    return { ok: false, status: 503, error: 'db_unavailable' };
  }
}
