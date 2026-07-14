import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  hasPurchasedOrders,
  resolveReferralCode,
  setReferrerOnce,
} from '@oplati/db';
import { parseReferralCode } from '@oplati/types';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Захват реферера при входе в Mini App по `start_param` (deep-link
 * `telegram.me/<bot>/<app>?startapp=ref_<code>`). Дополняет основной путь `/start ref_`
 * бота: клиенты фактически заходят через приложение (кнопка ☰ / web_app), где
 * `/start` не срабатывает и код иначе теряется.
 *
 * Best-effort: любая ошибка глотается (Sentry), кабинет продолжает работать.
 * Гарантии установки — на `setReferrerOnce` (immutable, запрет самореферала).
 *
 * Антифрод-гейт: не привязываем пользователя, у которого уже есть состоявшаяся
 * покупка — устоявшегося клиента нельзя задним числом «увести» под чужую ссылку.
 * Свежий приглашённый (ещё без заказов) привязывается ДО первой оплаты, поэтому
 * комиссия за первый заказ начислится штатно (`paid_at >= referred_by_set_at`).
 */

const log = childLogger('referral.capture');

/** Откуда пришёл захват — для логов/аналитики. */
type CaptureSource = 'miniapp_startapp' | 'bot_start';

/**
 * Отложенная привязка уже существующего пользователя к рефереру. Best-effort.
 * Антифрод-гейт: пропускаем, если у пользователя уже есть состоявшаяся покупка.
 * Идемпотентность/самореферал — на `setReferrerOnce`.
 */
export async function captureReferralForUser(input: {
  userId: string;
  referrerId: string;
  source: CaptureSource;
}): Promise<void> {
  if (!serverEnv.REFERRAL_ENABLED) return;
  const { userId, referrerId, source } = input;
  if (referrerId === userId) return;

  try {
    const db = getDb();
    // Антифрод: устоявшегося покупателя не переприсваиваем реферер-ссылке.
    if (await hasPurchasedOrders(db, userId)) {
      log.info({ event: 'referral.capture.skipped_has_purchases', userId, source });
      return;
    }
    const result = await setReferrerOnce(db, userId, referrerId, log);
    log.info({
      event: result.set ? 'referral.capture.set' : 'referral.capture.noop',
      userId,
      reason: result.set ? undefined : result.reason,
      source,
    });
  } catch (err) {
    log.warn({ event: 'referral.capture.failed', userId, source, err });
    Sentry.captureException(err, { tags: { source: 'referral.capture' } });
  }
}

/**
 * Захват реферера при входе в Mini App по `start_param` (`startapp=ref_<code>`).
 * Резолвит код в реферера и делегирует в `captureReferralForUser`.
 */
export async function captureReferralFromStartParam(input: {
  userId: string;
  startParam: string | null;
}): Promise<void> {
  if (!serverEnv.REFERRAL_ENABLED) return;
  const { userId, startParam } = input;
  if (!startParam) return;

  const code = parseReferralCode(startParam);
  if (!code) return;

  let referrerId: string | null = null;
  try {
    referrerId = await resolveReferralCode(getDb(), code);
  } catch (err) {
    log.warn({ event: 'referral.capture.resolve_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.capture' } });
    return;
  }
  if (!referrerId) return;

  await captureReferralForUser({ userId, referrerId, source: 'miniapp_startapp' });
}
