import 'server-only';

import { cookies } from 'next/headers';

import * as Sentry from '@sentry/nextjs';

import { getDb, resolveReferralCode } from '@oplati/db';
import { parseReferralCode } from '@oplati/types';

import { serverEnv } from '@/lib/env';
import { childLogger } from '@/lib/logger';

/**
 * Захват реферера из cookie `ref` — общий для всех точек, где впервые создаётся
 * web-пользователь (чат `/api/chat` И партнёрский кабинет `/api/cabinet/referral`).
 * Cookie ставит middleware из `?ref=<code>`.
 *
 * Важно (находка greptile): любая точка, создающая web-юзера, ОБЯЗАНА сперва
 * позвать `consumeRefCookie` и передать результат как `referredBy` — иначе юзер
 * создаётся с `referred_by=NULL`, а реферер потом не проставится (immutable),
 * и реферал теряется навсегда.
 */

const log = childLogger('referral-capture');

/**
 * Резолвит id реферера из cookie `ref`. Гейтится `REFERRAL_ENABLED`. Best-effort:
 * выключено / неизвестный код / сбой → `null` (захвата нет — это не ошибка).
 * Cookie НЕ гасит: при сбое реферер не должен пропасть (повторится на следующем
 * запросе). Гасит — `clearRefCookie` ПОСЛЕ успешного создания пользователя.
 */
export async function consumeRefCookie(): Promise<string | null> {
  if (!serverEnv.REFERRAL_ENABLED) return null;
  const store = await cookies();
  const code = parseReferralCode(store.get('ref')?.value);
  if (!code) return null;
  try {
    const referrerId = await resolveReferralCode(getDb(), code);
    log.info({ event: referrerId ? 'referral.captured' : 'referral.code_unknown' });
    return referrerId;
  } catch (err) {
    log.warn({ event: 'referral.resolve_failed', err });
    Sentry.captureException(err, { tags: { source: 'referral.capture' } });
    return null;
  }
}

/** Гасит ref-cookie одноразово — звать ТОЛЬКО после успешного создания/upsert юзера. */
export async function clearRefCookie(): Promise<void> {
  const store = await cookies();
  if (store.get('ref')) store.delete('ref');
}
