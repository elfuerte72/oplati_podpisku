import "server-only";

import * as Sentry from "@sentry/nextjs";

import {
  applyMonthlyProgression,
  getDb,
  getLatestRolledUpMonth,
  getMonthlyRollupInput,
  getPartnerProfile,
  getPriorConsecutiveMetMonths,
  getUserTelegramId,
  listReferralRollupCandidates,
} from "@oplati/db";
import {
  REFERRAL_RATE_TABLE,
  clampCircle,
  planMonthlyProgression,
  type MonthlyProgressionResult,
} from "@oplati/types";

import { notifyOps } from "../alerts/notify-ops.ts";
import { serverEnv } from "../env.ts";
import { childLogger } from "../logger.ts";
import { getBot } from "../telegram/bot.ts";

const log = childLogger("cron.referral-rollup");

/** Ставка L1 по умолчанию (Клиент, 4%) — когда профиля партнёра ещё нет. */
const DEFAULT_LOCKED_L1_BPS = REFERRAL_RATE_TABLE[0]?.l1Bps ?? 400;

export type RollupWindow = {
  /** Первое число ОБРАБАТЫВАЕМОГО (завершившегося) месяца — `'YYYY-MM-01'`. */
  monthKey: string;
  /** Последний день месяца ЗАПУСКА (буст действует весь этот месяц) — `'YYYY-MM-DD'`. */
  boostUntil: string;
};

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Окно rollup из момента запуска (UTC). Крон стоит на 1-е число месяца, поэтому
 * обрабатывается ПРЕДЫДУЩИЙ (завершившийся) месяц, а буст, выданный за его
 * оборот, действует весь ТЕКУЩИЙ месяц запуска. Чистая функция от `now` — дата-
 * математика тестируется без реального времени (передаём фиксированный `now`).
 */
export function computeRollupWindow(now: Date): RollupWindow {
  // Первое число предыдущего месяца.
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  // Последний день месяца запуска = «нулевой» день следующего месяца.
  const boostEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  );
  return { monthKey: fmtDate(target), boostUntil: fmtDate(boostEnd) };
}

export type RollupResult = {
  scanned: number;
  applied: number;
  bonuses: number;
  upgrades: number;
  errors: number;
  /**
   * Месяцы, которые крон пропустил и которые НЕ посчитаны этим прогоном.
   * Непустой список — повод для ручного разбора, а не отчёт о работе.
   */
  missedMonths: string[];
};

/** `'YYYY-MM-01'` → следующий месяц в том же формате. */
function nextMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return fmtDate(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + 1, 1)));
}

/**
 * Месяцы, которые крон пропустил: между последним посчитанным и целевым.
 *
 * Крон стоит на 1-е число месяца в 02:00 UTC, и простой машины в это окно терял
 * месяц прогрессии молча (аудит 2026-08-10): следующий запуск считает только
 * предыдущий месяц, а про дыру не знает никто.
 *
 * ⚠️ Функция только НАХОДИТ пропуск. Считать такие месяцы автоматически нельзя,
 * и это не лень, а разбор рисков (ревью 2026-08-11): `getMonthlyRollupInput`
 * считает «новых активных рефералов» БЕЗ верхней границы по времени, то есть
 * задним числом старый месяц получил бы сегодняшние покупки и спринт-бонус,
 * которого тогда не заработали, — а ledger append-only, отменить нельзя. Плюс
 * буст пишется сроком месяца ЗАПУСКА и затирается следующей итерацией, а
 * водяной знак глобален (месяц считается закрытым, как только его посчитали
 * хоть кому-то). Пока это не разобрано, добор делает человек — см.
 * `docs/BACKLOG.md`.
 *
 * Пустая история пропуском НЕ считается: у первого запуска программы истории
 * нет по определению.
 */
export function findMissedMonths(
  latestRolledUp: string | null,
  targetMonth: string,
): string[] {
  if (!latestRolledUp || latestRolledUp >= targetMonth) return [];

  const missed: string[] = [];
  let cursor = nextMonthKey(latestRolledUp);
  // Жёсткая граница обхода — страховка от кривой даты в БД, а не бизнес-правило.
  for (let i = 0; cursor < targetMonth && i < 1200; i++) {
    missed.push(cursor);
    cursor = nextMonthKey(cursor);
  }
  return missed;
}

/**
 * Cron `referral-rollup` (1-е число месяца): месячная прогрессия партнёров —
 * храповик кругов, бонусы (достижение/спринт/серия), спринт-буст. Решение
 * считает чистый `planMonthlyProgression`; применение атомарно и идемпотентно
 * на партнёра за месяц (PK `referral_monthly_stats`).
 *
 * Гейт `REFERRAL_ENABLED`. Ошибка по одному партнёру не валит прогон (Sentry +
 * счётчик errors). Уведомление партнёру шлётся только при повышении круга или
 * начисленном бонусе, graceful (сбой Telegram не откатывает применённую прогрессию).
 */
export async function rollupReferralMonth(opts?: {
  now?: Date;
}): Promise<RollupResult> {
  if (!serverEnv.REFERRAL_ENABLED) {
    log.info({ event: "cron.referral_rollup.skipped_disabled" });
    return {
      scanned: 0,
      applied: 0,
      bonuses: 0,
      upgrades: 0,
      errors: 0,
      missedMonths: [],
    };
  }

  const now = opts?.now ?? new Date();
  const { monthKey, boostUntil } = computeRollupWindow(now);

  const db = getDb();
  // Пропущенный запуск (простой машины 1-го числа в 02:00 UTC) больше не
  // теряется МОЛЧА: до аудита 2026-08-10 о дыре не узнавал никто. Считать такой
  // месяц автоматически нельзя (см. findMissedMonths) — поэтому громко зовём
  // человека, а прогон продолжаем за целевой месяц.
  const missedMonths = findMissedMonths(
    await getLatestRolledUpMonth(db),
    monthKey,
  );
  if (missedMonths.length > 0) {
    log.error({
      event: "cron.referral_rollup.missed_months",
      missedMonths,
      monthKey,
    });
    Sentry.captureMessage("Referral rollup: пропущены месяцы прогрессии", {
      level: "error",
      tags: { source: "cron.referral-rollup" },
      extra: { missedMonths, monthKey },
    });
    await notifyOps(
      `Реферальная прогрессия: не посчитаны месяцы ${missedMonths.join(", ")} ` +
        `(крон не отработал 1-го числа). Нужен ручной прогон — автодобор осознанно ` +
        `не делается, он выдал бы бонусы задним числом. Подробности в docs/BACKLOG.md.`,
    );
  }
  log.info({ event: "cron.referral_rollup.start", monthKey, missedMonths });

  const candidates = await listReferralRollupCandidates(db);

  let applied = 0;
  let bonuses = 0;
  let upgrades = 0;
  let errors = 0;
  const month = monthKey;
  // Кандидаты обрабатываются последовательно (≈4 round-trip'а на партнёра). При
  // масштабе проекта (~50 заказов/день → десятки партнёров с сетью) это укладывается
  // в 300s maxDuration с большим запасом, а изоляция ошибок и per-partner
  // идемпотентность-транзакция читаются проще, чем батч. Наблюдение перфа (Greptile
  // P2): при росте до сотен+ партнёров — вернуться к батчингу reads/apply.
  for (const userId of candidates) {
    try {
      const [input, profile, prior] = await Promise.all([
        getMonthlyRollupInput(db, userId, month),
        getPartnerProfile(db, userId),
        getPriorConsecutiveMetMonths(db, userId, month),
      ]);

      const plan = planMonthlyProgression({
        currentCircle: profile?.circle ?? 0,
        lockedRateL1Bps: profile?.lockedRateL1Bps ?? DEFAULT_LOCKED_L1_BPS,
        networkTurnoverUsdCents: input.networkTurnoverUsdCents,
        newActiveReferrals: input.newActiveReferrals,
        priorConsecutiveMetMonths: prior,
      });

      const res = await applyMonthlyProgression(
        db,
        {
          userId,
          monthKey: month,
          stats: {
            networkTurnoverUsdCents: input.networkTurnoverUsdCents,
            newActiveReferrals: input.newActiveReferrals,
            planMet: plan.planMet,
            consecutiveMetMonths: plan.consecutiveMetMonths,
          },
          profile: {
            newCircle: plan.newCircle,
            newLockedRateL1Bps: plan.newLockedRateL1Bps,
          },
          boost: plan.boostGranted
            ? { until: boostUntil, rateBps: plan.boostBps }
            : null,
          bonuses: plan.bonuses,
        },
        log,
      );

      if (res.applied) {
        applied++;
        bonuses += res.bonusesInserted;
        if (plan.circleUpgraded) upgrades++;
        // boostGranted оценивается независимо (оборот ≥150% порога) и может быть
        // true без повышения/бонусов (партнёр уже на макс. статусе) — иначе
        // партнёр получил бы +1%, но молча, без уведомления (находка CodeRabbit + Greptile P1).
        if (
          plan.circleUpgraded ||
          plan.bonuses.length > 0 ||
          plan.boostGranted
        ) {
          await notifyPartnerProgression(db, userId, plan);
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: "cron.referral_rollup.partner_error", userId, err });
      Sentry.captureException(err, {
        tags: { source: "cron.referral-rollup" },
        extra: { userId, monthKey: month },
      });
    }
  }

  log.info({
    event: "cron.referral_rollup.done",
    monthKey,
    missedMonths,
    scanned: candidates.length,
    applied,
    bonuses,
    upgrades,
    errors,
  });
  return {
    scanned: candidates.length,
    applied,
    bonuses,
    upgrades,
    errors,
    missedMonths,
  };
}

/** USD-центы → `$X.XX`. */
function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const BONUS_LABEL: Record<string, string> = {
  circle_bonus: "Бонус за достижение статуса",
  sprint_new_refs: "Бонус спринта «новые активные»",
  serial_bonus: "Серийный бонус",
};

/**
 * Уведомляет партнёра в Telegram о повышении статуса и/или начисленных бонусах.
 * Никогда не бросает: сбой доставки логируется, но НЕ откатывает уже применённую
 * прогрессию (она в БД). Веб-партнёра без Telegram молча пропускаем.
 */
async function notifyPartnerProgression(
  db: ReturnType<typeof getDb>,
  userId: string,
  plan: MonthlyProgressionResult,
): Promise<void> {
  try {
    const telegramId = await getUserTelegramId(db, userId);
    if (!telegramId) return;

    const lines: string[] = [];
    if (plan.circleUpgraded) {
      const label =
        REFERRAL_RATE_TABLE[clampCircle(plan.newCircle)]?.label ?? "";
      const ratePct = (plan.newLockedRateL1Bps / 100).toLocaleString("ru-RU", {
        maximumFractionDigits: 2,
      });
      lines.push(
        `Поздравляем! Вы достигли статуса «${label}» — ставка ${ratePct}% зафиксирована навсегда.`,
      );
    }
    for (const b of plan.bonuses) {
      if (b.amountUsdCents <= 0) continue;
      lines.push(
        `${BONUS_LABEL[b.kind] ?? "Бонус"}: +${fmtUsd(b.amountUsdCents)}`,
      );
    }
    if (plan.boostGranted) {
      lines.push(
        "Активирован буст +1% к вашей ставке на этот месяц — так держать!",
      );
    }
    if (lines.length === 0) return;

    lines.push("", "Подробности — в партнёрском кабинете.");
    // chat_id строкой: Bot API принимает string, Number() терял бы точность.
    await getBot().api.sendMessage(telegramId, lines.join("\n"));
    log.info({ event: "cron.referral_rollup.notified", userId });
  } catch (err) {
    log.error({ event: "cron.referral_rollup.notify_failed", userId, err });
    Sentry.captureException(err, {
      tags: { source: "cron.referral-rollup", step: "notify" },
    });
  }
}
