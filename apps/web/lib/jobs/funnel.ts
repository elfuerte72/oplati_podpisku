import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  ensureReferralCode,
  findCompletedOrdersForRating,
  findExpiredOrdersForSurvey,
  findFreshUsersWithoutOrders,
  findRatedUsersForReferralNudge,
  getDb,
  getServiceById,
} from '@oplati/db';
import type { FunnelKind } from '@oplati/types';

import { formatReferralTelegramLink } from '@/lib/cabinet/referral-read';
import { serverEnv } from '@/lib/env.server';
import { sendFunnelMessage, type FunnelMessageContent } from '@/lib/funnel/gate';
import { childLogger } from '@/lib/logger';
import { getBotUsername } from '@/lib/telegram/bot';
import { referralMiniAppShortName } from '@/lib/telegram/deep-links';
import {
  buildExpiredSurveyKeyboard,
  buildRatingKeyboard,
  buildReferralNudgeKeyboard,
  buildStartSurveyKeyboard,
} from '@/lib/telegram/funnel-callbacks';
import {
  EXPIRED_SURVEY_TEXT,
  START_SURVEY_TEXT,
  buildOrderRatingText,
  buildReferralNudgeText,
} from '@/lib/telegram/templates';

/**
 * Cron `funnel` — движок воронки обратной связи (спека
 * `.scratch/retention-funnel/`), раз в 15 минут. Четыре вида сообщений, у
 * каждого своё скользящее окно ШИРЕ шага крона: дедуп держит атомарный claim
 * привратника, а не выборка, — и то же окно даёт но-бэкфилл (событие старше
 * окна не рассылается никогда, включение флага не трогает существующую базу).
 *
 * Вся отправка — ТОЛЬКО через `sendFunnelMessage` (тикет 01): здесь нет ни
 * одного прямого вызова Telegram и ни одного клиентского текста (тикет 07).
 */

const log = childLogger('cron.funnel');

const HOUR_MS = 60 * 60 * 1000;

// Окна видов сообщений (спека, таблица kind'ов): [задержка, глубина].
const EXPIRED_DELAY_H = 3;
const EXPIRED_LOOKBACK_H = 24;
const START_DELAY_H = 24;
const START_LOOKBACK_H = 72;
const RATING_DELAY_H = 1; // +1 час — решение владельца: клиент «горячий».
const RATING_LOOKBACK_H = 24;
const NUDGE_DELAY_H = 48;
const NUDGE_LOOKBACK_H = 96;

export type FunnelPhaseResult = { sent: number; skipped: number; errors: number };

export type FunnelJobResult = {
  enabled: boolean;
  expiredSurvey: FunnelPhaseResult;
  startSurvey: FunnelPhaseResult;
  orderRating: FunnelPhaseResult;
  referralNudge: FunnelPhaseResult;
};

function emptyPhase(): FunnelPhaseResult {
  return { sent: 0, skipped: 0, errors: 0 };
}

export async function runFunnelJob(opts: { now?: Date } = {}): Promise<FunnelJobResult> {
  const now = opts.now ?? new Date();
  const result: FunnelJobResult = {
    enabled: serverEnv.RETENTION_FUNNEL_ENABLED,
    expiredSurvey: emptyPhase(),
    startSurvey: emptyPhase(),
    orderRating: emptyPhase(),
    referralNudge: emptyPhase(),
  };

  // Выключенный флаг — тишина без выборок: привратник отказал бы каждому
  // кандидату по одному, но гонять четыре запроса ради этого незачем.
  if (!result.enabled) {
    log.info({ event: 'cron.funnel.disabled' });
    return result;
  }

  log.info({ event: 'cron.funnel.start' });

  await runExpiredSurveyPhase(now, result.expiredSurvey);
  await runStartSurveyPhase(now, result.startSurvey);
  await runOrderRatingPhase(now, result.orderRating);
  await runReferralNudgePhase(now, result.referralNudge);

  log.info({
    event: 'cron.funnel.done',
    expiredSurvey: result.expiredSurvey,
    startSurvey: result.startSurvey,
    orderRating: result.orderRating,
    referralNudge: result.referralNudge,
  });
  return result;
}

function windowFor(now: Date, delayH: number, lookbackH: number): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - lookbackH * HOUR_MS),
    to: new Date(now.getTime() - delayH * HOUR_MS),
  };
}

/**
 * Обёртка одной отправки: ожидаемые отказы привратника — `skipped`,
 * неожиданный сбой (БД, сборка контента) — `errors` + Sentry, и джоба идёт
 * дальше: один клиент не роняет прогон (история 18 спеки).
 */
async function trySend(
  phase: FunnelPhaseResult,
  input: {
    userId: string;
    kind: FunnelKind;
    orderId?: string;
    now: Date;
    build: () => Promise<FunnelMessageContent> | FunnelMessageContent;
  },
): Promise<void> {
  try {
    const res = await sendFunnelMessage(input);
    if (res.ok) phase.sent++;
    else phase.skipped++;
  } catch (err) {
    phase.errors++;
    log.error({ event: 'cron.funnel.item_error', kind: input.kind, userId: input.userId, err });
    Sentry.captureException(err, {
      tags: { source: 'cron.funnel' },
      extra: { kind: input.kind, userId: input.userId },
    });
  }
}

/** msg1: «что помешало оплатить?» через 3 часа после протухшего заказа. */
async function runExpiredSurveyPhase(now: Date, phase: FunnelPhaseResult): Promise<void> {
  const rows = await findExpiredOrdersForSurvey(
    getDb(),
    windowFor(now, EXPIRED_DELAY_H, EXPIRED_LOOKBACK_H),
  );
  // Два протухших заказа одного клиента в окне → один опрос: дедупим в
  // проходе (страхует claim по (user, kind), но зачем жечь заходы).
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    await trySend(phase, {
      userId: row.userId,
      kind: 'expired_survey',
      orderId: row.orderId,
      now,
      build: () => ({ text: EXPIRED_SURVEY_TEXT, keyboard: buildExpiredSurveyKeyboard() }),
    });
  }
}

/** msg2: «нашёл, что искал?» назавтра после первого визита без заказа. */
async function runStartSurveyPhase(now: Date, phase: FunnelPhaseResult): Promise<void> {
  const rows = await findFreshUsersWithoutOrders(
    getDb(),
    windowFor(now, START_DELAY_H, START_LOOKBACK_H),
  );
  for (const row of rows) {
    await trySend(phase, {
      userId: row.userId,
      kind: 'start_survey',
      now,
      build: () => ({ text: START_SURVEY_TEXT, keyboard: buildStartSurveyKeyboard() }),
    });
  }
}

/** msg3: оценка 1–5 через час после выдачи карты. */
async function runOrderRatingPhase(now: Date, phase: FunnelPhaseResult): Promise<void> {
  const db = getDb();
  const rows = await findCompletedOrdersForRating(
    db,
    windowFor(now, RATING_DELAY_H, RATING_LOOKBACK_H),
  );
  for (const row of rows) {
    await trySend(phase, {
      userId: row.userId,
      kind: 'order_rating',
      orderId: row.orderId,
      now,
      build: async () => {
        // Имя сервиса — лениво, после всех проверок привратника; для
        // custom-заказов нейтральная форма (buildOrderRatingText). Сбой
        // чтения не роняет отправку (нейтральный текст), но и не глотается
        // молча: claim уже занят, и второй попытки у этого заказа не будет.
        let serviceLabel: string | null = null;
        if (row.serviceId) {
          const service = await getServiceById(db, row.serviceId).catch((err: unknown) => {
            log.warn({
              event: 'cron.funnel.service_lookup_failed',
              orderId: row.orderId,
              serviceId: row.serviceId,
              err,
            });
            return null;
          });
          serviceLabel = service?.name ?? null;
        }
        return {
          text: buildOrderRatingText(serviceLabel),
          keyboard: buildRatingKeyboard(row.orderId),
        };
      },
    });
  }
}

/** msg4: персональная реферальная ссылка через 2 дня после оценки ≥4. */
async function runReferralNudgePhase(now: Date, phase: FunnelPhaseResult): Promise<void> {
  // Партнёрская программа выключена → ссылки не существует, касание не имеет
  // смысла: тишина, а не сообщение без ссылки (тикет 06).
  if (!serverEnv.REFERRAL_ENABLED) return;

  const db = getDb();
  const rows = await findRatedUsersForReferralNudge(
    db,
    windowFor(now, NUDGE_DELAY_H, NUDGE_LOOKBACK_H),
  );
  if (rows.length === 0) return;

  // Один getMe на прогон, не на клиента. Не резолвится → фаза пропускается
  // ЦЕЛИКОМ до следующего прогона: ссылку без username не собрать, а заход в
  // привратник сжёг бы одноразовый claim «раз за жизнь» впустую.
  let botUsername: string;
  try {
    botUsername = await getBotUsername();
  } catch (err) {
    log.warn({ event: 'cron.funnel.bot_username_failed', err });
    return;
  }

  for (const row of rows) {
    // Ссылка — ТЕМ ЖЕ кодом, что в кабинете (ensureReferralCode +
    // formatReferralTelegramLink): расходиться им нельзя. Собирается ДО
    // привратника: сбой сборки ПОСЛЕ claim'а терял бы касание навсегда,
    // а лишний идемпотентный ensureReferralCode при отказе бюджета дёшев.
    let link: string | null = null;
    try {
      const code = await ensureReferralCode(db, row.userId);
      link = formatReferralTelegramLink(code, botUsername, referralMiniAppShortName());
    } catch (err) {
      phase.errors++;
      log.error({ event: 'cron.funnel.referral_link_failed', userId: row.userId, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.funnel' },
        extra: { kind: 'referral_nudge', userId: row.userId },
      });
      continue;
    }
    if (!link) {
      // formatReferralTelegramLink отдал null (нет кода) — кандидат
      // пропускается без claim'а, попробуем в следующем прогоне.
      phase.skipped++;
      continue;
    }
    const content = { text: buildReferralNudgeText(link), keyboard: buildReferralNudgeKeyboard() };
    await trySend(phase, {
      userId: row.userId,
      kind: 'referral_nudge',
      now,
      build: () => content,
    });
  }
}
