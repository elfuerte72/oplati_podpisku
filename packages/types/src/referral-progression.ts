import {
  REFERRAL_RATE_TABLE,
  clampCircle,
} from './referral.ts';

/**
 * Прогрессия партнёра (Этап C) — чистое ядро месячного крона `referral-rollup`.
 *
 * По завершении календарного месяца крон считает по каждому партнёру оборот его
 * сети (D-REF-2), новых активных рефералов (D-REF-5) и активных L2, а затем этот
 * модуль решает:
 *  - **храповик круга** — оборот сети пересёк порог → повышение круга и фиксация
 *    ставки L1 навсегда (никогда не понижается);
 *  - **бонус достижения круга** — разовый $50 (Партнёр) / $150 (Топ-партнёр);
 *  - **спринт «новые активные»** — 10+ новых активных рефералов за месяц → $30;
 *  - **спринт-буст оборота** — оборот ≥150% порога круга → +1% к L1 на след. месяц;
 *  - **серийный бонус** — 3 месяца подряд с выполненным планом → $25/$75/$200;
 *  - **командный множитель** — 5+ активных L2 → ставка L2 2%→2.5% (флаг на партнёре).
 *
 * Деньги — USD-центы integer. Ставки — bps. Всё детерминировано входными данными
 * (месяц передаётся кроном параметром — без `Date.now()` в логике), поэтому
 * функция тестируется без БД и без времени. Источник правил — SPEC.md §3, PLAN.md
 * Этап C, referral_rules.docx v1.0 разделы 3–5.
 */

// ─── Конфиг прогрессии (единственный источник правды бонусов) ──────────────

/** Порог спринта «новые активные рефералы» за месяц. */
export const REFERRAL_SPRINT_NEW_REFS_GOAL = 10;

/** Разовый бонус за спринт «10+ новых активных» (USD-центы) — $30. */
export const REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS = 3_000;

/** Порог спринт-буста оборота: ≥150% порога текущего круга. */
export const REFERRAL_TURNOVER_BOOST_RATIO_PERCENT = 150;

/** Временный буст к ставке L1 на следующий месяц (bps) — +1%. */
export const REFERRAL_TURNOVER_BOOST_BPS = 100;

/** Порог командного множителя: 5+ активных рефералов 2-го уровня. */
export const REFERRAL_TEAM_MULTIPLIER_MIN_ACTIVE_L2 = 5;

/** Длина серии для серийного бонуса: план выполнен N месяцев подряд. */
export const REFERRAL_SERIAL_PERIOD_MONTHS = 3;

/**
 * Серийный бонус по кругу (USD-центы), индекс = круг 0..3. Круг 0 (Клиент) —
 * бонуса нет; Старт $25 / Партнёр $75 / Топ-партнёр $200. Даётся, когда серия
 * выполненных планов достигает кратного `REFERRAL_SERIAL_PERIOD_MONTHS` (3, 6, …).
 */
export const REFERRAL_SERIAL_BONUS_USD_CENTS: readonly number[] = [0, 2_500, 7_500, 20_000] as const;

// ─── Пороги (чистые вычисления) ────────────────────────────────────────────

/**
 * Наивысший круг (0..3), порог которого покрыт месячным оборотом сети. Круг 0
 * (порог 0) — базовый; круги 1..3 требуют пересечения своего порога. Оборот
 * ровно на пороге засчитывается (≥).
 */
export function highestCircleForTurnover(networkTurnoverUsdCents: number): number {
  let circle = 0;
  for (let i = 1; i < REFERRAL_RATE_TABLE.length; i++) {
    const row = REFERRAL_RATE_TABLE[i];
    if (row && networkTurnoverUsdCents >= row.thresholdUsdCents) circle = i;
  }
  return circle;
}

/**
 * «План месяца» (USD-центы) для plan_met/буста — порог текущего круга. Для круга 0
 * (Клиент, порог 0) берём порог круга 1 ($500) как осмысленный ориентир (та же
 * база, что у витрины кабинета), иначе план был бы тривиально выполнен всегда.
 */
export function planThresholdUsdCents(circle: number): number {
  const c = Math.max(1, clampCircle(circle));
  return REFERRAL_RATE_TABLE[c]?.thresholdUsdCents ?? 0;
}

// ─── Планировщик месячной прогрессии ───────────────────────────────────────

export type MonthlyProgressionInput = {
  /** Текущий круг партнёра (0..3) на начало месяца. */
  readonly currentCircle: number;
  /** Зафиксированная ставка L1 (bps) до этого месяца. */
  readonly lockedRateL1Bps: number;
  /** Оборот сети (L1+L2+L3) за месяц, USD-центы (D-REF-2). */
  readonly networkTurnoverUsdCents: number;
  /** Новые активные рефералы L1 за месяц (D-REF-5). */
  readonly newActiveReferrals: number;
  /** Активные рефералы 2-го уровня (≥1 покупка) — для командного множителя. */
  readonly activeL2Count: number;
  /** Серия выполненных планов на конец ПРЕДЫДУЩЕГО месяца (0 если нет истории). */
  readonly priorConsecutiveMetMonths: number;
};

export type ProgressionBonusKind = 'circle_bonus' | 'sprint_new_refs' | 'serial_bonus';

/** Одно спланированное бонус-начисление (пишется строкой в referral_accruals, level 0). */
export type ProgressionBonus = {
  readonly kind: ProgressionBonusKind;
  readonly amountUsdCents: number;
};

export type MonthlyProgressionResult = {
  /** Круг после храповика (≥ currentCircle). */
  readonly newCircle: number;
  readonly circleUpgraded: boolean;
  /** Ставка L1 после фиксации (≥ прежней). */
  readonly newLockedRateL1Bps: number;
  /** 5+ активных L2 в этом месяце. */
  readonly teamMultiplier: boolean;
  /** Буст к L1 на следующий месяц (bps); 0 если не выдан. */
  readonly boostBps: number;
  readonly boostGranted: boolean;
  /** Выполнен ли план месяца (оборот ≥ порога круга). */
  readonly planMet: boolean;
  /** Серия выполненных планов, включая этот месяц (0 если план не выполнен). */
  readonly consecutiveMetMonths: number;
  readonly bonuses: readonly ProgressionBonus[];
  readonly totalBonusUsdCents: number;
};

/**
 * Считает прогрессию партнёра за завершившийся месяц. Чистая функция —
 * идемпотентность и запись в БД обеспечивает крон (месяц обрабатывается один раз
 * благодаря PK(user_id, month) в referral_monthly_stats).
 *
 * Инварианты:
 *  - **храповик**: `newCircle ≥ currentCircle`, `newLockedRateL1Bps ≥` прежней —
 *    круг и ставка НИКОГДА не понижаются;
 *  - бонус достижения даётся за КАЖДЫЙ пройденный за месяц круг (при скачке сразу
 *    через несколько порогов — сумма бонусов пройденных кругов);
 *  - серийный бонус — только когда серия кратна `REFERRAL_SERIAL_PERIOD_MONTHS`
 *    (3, 6, …), чтобы не платить его каждый месяц длинной серии.
 */
export function planMonthlyProgression(input: MonthlyProgressionInput): MonthlyProgressionResult {
  const currentCircle = clampCircle(input.currentCircle);
  const achieved = highestCircleForTurnover(input.networkTurnoverUsdCents);
  const newCircle = Math.max(currentCircle, achieved); // храповик — не понижается
  const circleUpgraded = newCircle > currentCircle;

  // Ставка L1 фиксируется на уровне нового круга, но не ниже уже зафиксированной.
  const tableL1 = REFERRAL_RATE_TABLE[newCircle]?.l1Bps ?? input.lockedRateL1Bps;
  const newLockedRateL1Bps = Math.max(input.lockedRateL1Bps, tableL1);

  const teamMultiplier = input.activeL2Count >= REFERRAL_TEAM_MULTIPLIER_MIN_ACTIVE_L2;

  // План и буст считаются от порога круга НА НАЧАЛО месяца (тот, что партнёр
  // должен был удержать), а не от нового — иначе скачок вверх задирал бы планку.
  const planThreshold = planThresholdUsdCents(currentCircle);
  const planMet = planThreshold > 0 && input.networkTurnoverUsdCents >= planThreshold;
  const consecutiveMetMonths = planMet ? input.priorConsecutiveMetMonths + 1 : 0;

  const boostThreshold = Math.ceil(
    (planThreshold * REFERRAL_TURNOVER_BOOST_RATIO_PERCENT) / 100,
  );
  const boostGranted = planThreshold > 0 && input.networkTurnoverUsdCents >= boostThreshold;
  const boostBps = boostGranted ? REFERRAL_TURNOVER_BOOST_BPS : 0;

  const bonuses: ProgressionBonus[] = [];

  // Бонус достижения — за каждый пройденный круг (Партнёр $50, Топ $150).
  if (circleUpgraded) {
    for (let c = currentCircle + 1; c <= newCircle; c++) {
      const amount = REFERRAL_RATE_TABLE[c]?.achievementBonusUsdCents ?? 0;
      if (amount > 0) bonuses.push({ kind: 'circle_bonus', amountUsdCents: amount });
    }
  }

  // Спринт «10+ новых активных рефералов» → $30.
  if (input.newActiveReferrals >= REFERRAL_SPRINT_NEW_REFS_GOAL) {
    bonuses.push({
      kind: 'sprint_new_refs',
      amountUsdCents: REFERRAL_SPRINT_NEW_REFS_BONUS_USD_CENTS,
    });
  }

  // Серийный бонус — при достижении кратного длины серии (3, 6, …), по новому кругу.
  if (
    consecutiveMetMonths > 0 &&
    consecutiveMetMonths % REFERRAL_SERIAL_PERIOD_MONTHS === 0
  ) {
    const amount = REFERRAL_SERIAL_BONUS_USD_CENTS[clampCircle(newCircle)] ?? 0;
    if (amount > 0) bonuses.push({ kind: 'serial_bonus', amountUsdCents: amount });
  }

  const totalBonusUsdCents = bonuses.reduce((sum, b) => sum + b.amountUsdCents, 0);

  return {
    newCircle,
    circleUpgraded,
    newLockedRateL1Bps,
    teamMultiplier,
    boostBps,
    boostGranted,
    planMet,
    consecutiveMetMonths,
    bonuses,
    totalBonusUsdCents,
  };
}
