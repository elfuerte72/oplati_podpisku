/**
 * View-типы партнёрского кабинета — контракт между `/api/cabinet/referral` и
 * клиентами (веб-страница `/partner` + секция мини-аппа). Обе поверхности рисуют
 * один и тот же снапшот.
 *
 * Конвенции (как в cabinet/types.ts):
 *  - деньги — целые USD-центы (`*UsdCents`); форматирует клиент;
 *  - ставки — bps (basis points): 600 = 6%;
 *  - даты — ISO-строки;
 *  - суммы выплат в истории — отрицательные (вывод уменьшает баланс).
 */

import type { ReferralLedgerRow, ReferralPayoutRow } from '@oplati/db';

/** Текущий круг партнёра + цель следующего. */
export type ReferralCircleView = {
  /** 0=Клиент .. 3=Топ-партнёр. */
  circle: number;
  label: string;
  nextLabel: string | null;
  nextThresholdUsdCents: number | null;
  achievementBonusUsdCents: number;
};

/** Эффективные ставки цепочки (bps) + ставка топ-круга для «заблокированного». */
export type ReferralRatesView = {
  l1Bps: number;
  l2Bps: number;
  l3Bps: number;
  /** Ставка L1 топ-круга (для строки «🔒 Круг 3 — 7%»). */
  topL1Bps: number;
};

/** Один уровень сети: размер, активность, оборот и доход партнёра с него. */
export type ReferralLevelView = {
  level: number;
  rateBps: number;
  total: number;
  active: number;
  turnoverThisMonthUsdCents: number;
  incomeThisMonthUsdCents: number;
  incomeAllTimeUsdCents: number;
};

/** Прогресс к следующему кругу (по обороту сети за месяц). */
export type ReferralProgressView = {
  networkTurnoverThisMonthUsdCents: number;
  nextThresholdUsdCents: number | null;
  /** 0..10000 (bps пути до следующего круга); 10000 на топ-круге. */
  progressBps: number;
};

/** Спринт-цели месяца (витрина; начисление бонусов — Этап C). */
export type ReferralSprintView = {
  newReferralsThisMonth: number;
  newReferralsActive: number;
  newReferralsGoal: number;
  turnoverThisMonthUsdCents: number;
  /** 150% порога текущего круга — цель временного буста. */
  turnoverBoostThresholdUsdCents: number;
};

export type ReferralHistoryKind =
  | 'commission'
  | 'circle_bonus'
  | 'sprint_new_refs'
  | 'sprint_turnover_boost'
  | 'serial_bonus'
  | 'payout';

/** Запись ленты «История» (начисление или вывод). */
export type ReferralHistoryEntry = {
  kind: ReferralHistoryKind;
  title: string;
  subtitle: string;
  /** Уровень сети (1..3) для commission; null для бонусов/выводов. */
  level: number | null;
  /** USD-центы; отрицательные — вывод. */
  amountUsdCents: number;
  status: string;
  statusLabel: string;
  /** true для реверснутого начисления (показать зачёркнуто/приглушённо). */
  reversed: boolean;
  at: string;
};

/** Полный снимок кабинета партнёра. */
export type ReferralSnapshot = {
  /** Программа включена (`REFERRAL_ENABLED`). Если false — кабинет показывает заглушку. */
  enabled: boolean;
  /** Антифрод-блок (Этап E): выводы заморожены. */
  suspended: boolean;
  /** Личность подтверждена Telegram — требуется для выводов. */
  telegramLinked: boolean;
  referralCode: string | null;
  /** Ссылка для веб-захвата: `<APP_URL>?ref=<code>`. */
  webLink: string | null;
  /** Deep-link бота: `t.me/<bot>?start=ref_<code>`. */
  telegramLink: string | null;

  circle: ReferralCircleView;
  rates: ReferralRatesView;
  /** Ставка зафиксирована храповиком (достигнут ≥ Круг 1). */
  rateLockedForever: boolean;

  earnedThisMonthUsdCents: number;
  earnedTotalUsdCents: number;
  balanceUsdCents: number;
  minPayoutUsdCents: number;
  /** Можно подать заявку на вывод (привязан TG, не заблокирован, баланс ≥ минимума). */
  canPayout: boolean;

  progress: ReferralProgressView;
  sprint: ReferralSprintView;
  /** Ровно 3 уровня (отсутствующие — нулями). */
  levels: ReferralLevelView[];
  /** Доход помесячно — 6 точек (старые→новые), пропуски нулями. */
  monthlyIncome: { month: string; usdCents: number }[];
  history: ReferralHistoryEntry[];
};

const ACCRUAL_STATUS_LABELS: Record<string, string> = {
  accrued: 'Начислено',
  reversed: 'Отменено',
};

const PAYOUT_STATUS_LABELS: Record<string, string> = {
  requested: 'В обработке',
  processing: 'Выполняется',
  paid: 'Выплачено',
  rejected: 'Отклонено',
};

const BONUS_TITLES: Record<string, string> = {
  circle_bonus: 'Бонус за круг',
  sprint_new_refs: 'Спринт: новые рефералы',
  sprint_turnover_boost: 'Спринт: буст оборота',
  serial_bonus: 'Серийный бонус',
};

function commissionSubtitle(row: ReferralLedgerRow): string {
  const what = row.serviceName ?? row.customDescription ?? 'оплата';
  return `Ур. ${row.level} · ${what}`;
}

/** Маппинг строки ledger'а в запись истории. */
export function ledgerToHistoryEntry(row: ReferralLedgerRow): ReferralHistoryEntry {
  const reversed = row.status === 'reversed';
  if (row.kind === 'commission') {
    return {
      kind: 'commission',
      title: row.sourceName ?? 'Реферал',
      subtitle: commissionSubtitle(row),
      level: row.level,
      amountUsdCents: row.amountUsdCents,
      status: row.status,
      statusLabel: ACCRUAL_STATUS_LABELS[row.status] ?? row.status,
      reversed,
      at: row.createdAt.toISOString(),
    };
  }
  return {
    kind: (row.kind as ReferralHistoryKind) ?? 'circle_bonus',
    title: BONUS_TITLES[row.kind] ?? 'Бонус',
    subtitle: '',
    level: null,
    amountUsdCents: row.amountUsdCents,
    status: row.status,
    statusLabel: ACCRUAL_STATUS_LABELS[row.status] ?? row.status,
    reversed,
    at: row.createdAt.toISOString(),
  };
}

/** Маппинг заявки на вывод в запись истории (сумма отрицательная). */
export function payoutToHistoryEntry(row: ReferralPayoutRow): ReferralHistoryEntry {
  return {
    kind: 'payout',
    title: 'Вывод средств',
    subtitle: PAYOUT_STATUS_LABELS[row.status] ?? row.status,
    level: null,
    amountUsdCents: -row.amountUsdCents,
    status: row.status,
    statusLabel: PAYOUT_STATUS_LABELS[row.status] ?? row.status,
    reversed: row.status === 'rejected',
    at: row.requestedAt.toISOString(),
  };
}
