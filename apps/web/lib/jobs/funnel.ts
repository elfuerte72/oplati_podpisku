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
import { getFunnelTexts, renderFunnelText, type FunnelTextValues } from '@/lib/funnel/texts';
import { childLogger } from '@/lib/logger';
import { getBotUsername } from '@/lib/telegram/bot';
import { referralMiniAppShortName } from '@/lib/telegram/deep-links';
import {
  buildExpiredSurveyKeyboard,
  buildRatingKeyboard,
  buildReferralNudgeKeyboard,
  buildStartSurveyKeyboard,
} from '@/lib/telegram/funnel-callbacks';

/**
 * Cron `funnel` — движок воронки обратной связи (спека
 * `.scratch/retention-funnel/`), раз в 15 минут. Четыре вида сообщений, у
 * каждого своё скользящее окно ШИРЕ шага крона: дедуп держит атомарный claim
 * привратника, а не выборка, — и то же окно даёт но-бэкфилл (событие старше
 * окна не рассылается никогда, включение флага не трогает существующую базу).
 *
 * Вся отправка — ТОЛЬКО через `sendFunnelMessage` (тикет 01): здесь нет ни
 * одного прямого вызова Telegram и ни одного клиентского текста (тикет 07).
 * Тексты — через реестр `lib/funnel/texts.ts` (панель v2, ветка C): дефолты из
 * `templates.ts`, переопределения владельца из БД; читаются один раз на прогон,
 * при недоступной БД реестр отдаёт дефолты — воронка не падает из-за редактора.
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

  // Один поход за текстами на прогон: оверлей владельца поверх дефолтов.
  const texts = await getFunnelTexts();

  // Фазы изолированы друг от друга (ось E full-review): устойчивый сбой
  // ВЫБОРКИ одной фазы (сломался запрос к одной таблице) не должен глушить
  // остальные три вида сообщений до починки. Claim'ы при этом не сгорают —
  // падение происходит до привратника.
  await runPhaseSafely('expired_survey', result.expiredSurvey, () =>
    runExpiredSurveyPhase(now, result.expiredSurvey, texts),
  );
  await runPhaseSafely('start_survey', result.startSurvey, () =>
    runStartSurveyPhase(now, result.startSurvey, texts),
  );
  await runPhaseSafely('order_rating', result.orderRating, () =>
    runOrderRatingPhase(now, result.orderRating, texts),
  );
  await runPhaseSafely('referral_nudge', result.referralNudge, () =>
    runReferralNudgePhase(now, result.referralNudge, texts),
  );

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

/** Изоляция фазы: сбой (обычно выборки) — errors + Sentry, прогон идёт дальше. */
async function runPhaseSafely(
  phaseName: string,
  phase: FunnelPhaseResult,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    phase.errors++;
    log.error({ event: 'cron.funnel.phase_error', phase: phaseName, err });
    Sentry.captureException(err, { tags: { source: 'cron.funnel' }, extra: { phase: phaseName } });
  }
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
    // `send_failed` — неожиданный отказ Telegram при уже сожжённом claim'е:
    // это авария, а не штатный пропуск, и в JSON прогона она обязана быть
    // видна как ошибка (ось E full-review). `blocked` (403) остаётся
    // skipped — клиент, заблокировавший бота, штатен.
    else if (res.reason === 'send_failed') phase.errors++;
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
async function runExpiredSurveyPhase(
  now: Date,
  phase: FunnelPhaseResult,
  texts: FunnelTextValues,
): Promise<void> {
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
      build: () => ({
        text: texts['expired_survey.body'],
        keyboard: buildExpiredSurveyKeyboard(row.orderId, texts),
      }),
    });
  }
}

/** msg2: «нашёл, что искал?» назавтра после первого визита без заказа. */
async function runStartSurveyPhase(
  now: Date,
  phase: FunnelPhaseResult,
  texts: FunnelTextValues,
): Promise<void> {
  const rows = await findFreshUsersWithoutOrders(
    getDb(),
    windowFor(now, START_DELAY_H, START_LOOKBACK_H),
  );
  for (const row of rows) {
    await trySend(phase, {
      userId: row.userId,
      kind: 'start_survey',
      now,
      build: () => ({ text: texts['start_survey.body'], keyboard: buildStartSurveyKeyboard(texts) }),
    });
  }
}

/** msg3: оценка 1–5 через час после выдачи карты. */
async function runOrderRatingPhase(
  now: Date,
  phase: FunnelPhaseResult,
  texts: FunnelTextValues,
): Promise<void> {
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
        // custom-заказов нейтральная форма (`order_rating.body_generic`). Сбой
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
        // Рендер под защитой: claim уже занят, и падение здесь означало бы
        // заказ без просьбы об оценке навсегда. Негодный шаблон отсекается на
        // чтении реестра, но нейтральная форма дешевле потерянного касания.
        let text = texts['order_rating.body_generic'];
        if (serviceLabel) {
          try {
            text = renderFunnelText(texts['order_rating.body'], { service: serviceLabel });
          } catch (err) {
            log.error({ event: 'cron.funnel.render_failed', orderId: row.orderId, err });
            Sentry.captureException(err, {
              tags: { source: 'cron.funnel' },
              extra: { kind: 'order_rating', orderId: row.orderId },
            });
          }
        }
        return { text, keyboard: buildRatingKeyboard(row.orderId, texts) };
      },
    });
  }
}

/** msg4: персональная реферальная ссылка через 2 дня после оценки ≥4. */
async function runReferralNudgePhase(
  now: Date,
  phase: FunnelPhaseResult,
  texts: FunnelTextValues,
): Promise<void> {
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
    let content: FunnelMessageContent | null = null;
    try {
      const code = await ensureReferralCode(db, row.userId);
      const link = formatReferralTelegramLink(code, botUsername, referralMiniAppShortName());
      // Рендер — в ТОМ ЖЕ try: текст берётся из БД (оверлей панели), и хотя
      // негодную строку отсекает чтение реестра, брошенное здесь исключение
      // унесло бы ВСЮ фазу вместе с остальными клиентами — один клиент не
      // роняет прогон (code-review 2026-09-02).
      content = link
        ? { text: renderFunnelText(texts['referral_nudge.body'], { link }), keyboard: buildReferralNudgeKeyboard(texts) }
        : null;
    } catch (err) {
      phase.errors++;
      log.error({ event: 'cron.funnel.referral_link_failed', userId: row.userId, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.funnel' },
        extra: { kind: 'referral_nudge', userId: row.userId },
      });
      continue;
    }
    if (!content) {
      // formatReferralTelegramLink отдал null (нет кода) — кандидат
      // пропускается без claim'а, попробуем в следующем прогоне.
      phase.skipped++;
      continue;
    }
    const ready = content;
    await trySend(phase, {
      userId: row.userId,
      kind: 'referral_nudge',
      now,
      build: () => ready,
    });
  }
}
