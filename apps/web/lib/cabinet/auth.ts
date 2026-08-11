import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, getOrCreateUserByTelegramId } from '@oplati/db';
import type { TelegramWebAppUser } from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import {
  validateInitData,
  telegramUserDisplayName,
  type InitDataFailureReason,
} from '../telegram/init-data.ts';
import { captureReferralFromStartParam } from './referral-capture.ts';

/**
 * Резолв пользователя кабинета по `initData` Mini App: проверяем подпись,
 * затем upsert'им `users`-строку по `telegram_id`. Это единственная точка
 * авторизации кабинета — все запросы `/api/cabinet` проходят через неё.
 *
 * Шаг РАЗДЕЛЁН намеренно (аудит 2026-08-10): `verifyCabinetInitData` — чистая
 * проверка подписи без единого запроса в БД, `upsertCabinetUser` — запись.
 * Между ними роут вставляет per-identity rate-limit: `telegram_id` известен
 * сразу после проверки подписи, и лимитировать надо ДО upsert'а, иначе держатель
 * одной валидной `initData` оплачивает записью в БД каждый свой запрос, сколько
 * бы их ни было. `resolveCabinetUser` — прежняя склейка обоих шагов, оставлена
 * для партнёрского кабинета.
 *
 * Результат — дискриминированный: `ok:false` несёт HTTP-статус для роута
 * (`401` неверная/протухшая подпись, `500` бот-токен не настроен, `503` БД
 * недоступна).
 */

const log = childLogger('cabinet.auth');
const dbLog = childLogger('db');

export type CabinetUser = {
  userId: string;
  telegramId: string;
  user: TelegramWebAppUser;
};

/** Личность из ПОДПИСАННОЙ initData. Строки `users` за ней ещё может не быть. */
export type CabinetIdentity = {
  telegramId: string;
  user: TelegramWebAppUser;
  startParam: string | null;
};

export type ResolveCabinetUserResult =
  | { ok: true; user: CabinetUser }
  | { ok: false; status: number; error: InitDataFailureReason | 'misconfigured' | 'db_unavailable' };

export type VerifyCabinetInitDataResult =
  | { ok: true; identity: CabinetIdentity }
  | { ok: false; status: number; error: InitDataFailureReason | 'misconfigured' };

/** Только подпись: ни одного обращения к БД. */
export function verifyCabinetInitData(initData: string): VerifyCabinetInitDataResult {
  const botToken = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    log.error({ event: 'cabinet.auth.misconfigured', missing: 'TELEGRAM_BOT_TOKEN' });
    return { ok: false, status: 500, error: 'misconfigured' };
  }

  const validated = validateInitData(initData, botToken);
  if (!validated.ok) {
    log.warn({ event: 'cabinet.auth.rejected', reason: validated.reason });
    return { ok: false, status: 401, error: validated.reason };
  }

  return {
    ok: true,
    identity: {
      telegramId: String(validated.user.id),
      user: validated.user,
      startParam: validated.startParam,
    },
  };
}

/** Запись: upsert `users` по подтверждённому `telegram_id` + реферальный захват. */
export async function upsertCabinetUser(
  identity: CabinetIdentity,
): Promise<ResolveCabinetUserResult> {
  try {
    const { id } = await getOrCreateUserByTelegramId(
      getDb(),
      {
        telegramId: identity.telegramId,
        displayName: telegramUserDisplayName(identity.user),
        language: identity.user.language_code ?? 'ru',
      },
      dbLog,
    );
    // Реферальный захват из `startapp=ref_<code>` — best-effort, не влияет на auth
    // (helper сам глотает ошибки и гейтит по REFERRAL_ENABLED / покупкам).
    await captureReferralFromStartParam({ userId: id, startParam: identity.startParam });
    return {
      ok: true,
      user: { userId: id, telegramId: identity.telegramId, user: identity.user },
    };
  } catch (err) {
    log.error({ event: 'cabinet.auth.db_failed', err });
    Sentry.captureException(err, { tags: { source: 'cabinet.auth' } });
    return { ok: false, status: 503, error: 'db_unavailable' };
  }
}

export async function resolveCabinetUser(initData: string): Promise<ResolveCabinetUserResult> {
  const verified = verifyCabinetInitData(initData);
  if (!verified.ok) return verified;
  return upsertCabinetUser(verified.identity);
}
