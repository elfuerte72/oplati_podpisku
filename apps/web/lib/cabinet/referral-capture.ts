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
 * Чем кончился захват. Вызывающему важны два исхода: `set` (друг закреплён —
 * можно сказать об этом ему и партнёру) и `self_link` (человек открыл СВОЮ
 * ссылку — раньше это молча превращалось в обычное приветствие, и партнёры
 * решали, что ссылка сломана; разбор жалоб 2026-09-05). Остальные исходы —
 * штатное «ничего не изменилось», о котором клиенту говорить нечего.
 */
export type ReferralCaptureOutcome =
  | 'set'
  | 'already_set'
  | 'self_link'
  | 'has_purchases'
  | 'cycle'
  | 'user_not_found'
  | 'disabled'
  | 'failed';

/**
 * Отложенная привязка уже существующего пользователя к рефереру. Best-effort.
 * Антифрод-гейт: пропускаем, если у пользователя уже есть состоявшаяся покупка.
 * Идемпотентность/самореферал — на `setReferrerOnce`.
 */
export async function captureReferralForUser(input: {
  userId: string;
  referrerId: string;
  source: CaptureSource;
}): Promise<ReferralCaptureOutcome> {
  if (!serverEnv.REFERRAL_ENABLED) return 'disabled';
  const { userId, referrerId, source } = input;
  if (referrerId === userId) {
    // Раньше выход был без лога: в Loki такой заход выглядел как успешный
    // захват (`telegram.referral.captured`) без следа результата.
    log.info({ event: 'referral.capture.self_link', userId, source });
    return 'self_link';
  }

  try {
    const db = getDb();
    // Антифрод: устоявшегося покупателя не переприсваиваем реферер-ссылке.
    if (await hasPurchasedOrders(db, userId)) {
      log.info({ event: 'referral.capture.skipped_has_purchases', userId, source });
      return 'has_purchases';
    }
    const result = await setReferrerOnce(db, userId, referrerId, log);
    log.info({
      event: result.set ? 'referral.capture.set' : 'referral.capture.noop',
      userId,
      reason: result.set ? undefined : result.reason,
      source,
    });
    if (result.set) return 'set';
    // `self_referral` из репозитория недостижим: тот же гейт стоит выше.
    return result.reason === 'self_referral' ? 'self_link' : result.reason;
  } catch (err) {
    log.warn({ event: 'referral.capture.failed', userId, source, err });
    Sentry.captureException(err, { tags: { source: 'referral.capture' } });
    return 'failed';
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
