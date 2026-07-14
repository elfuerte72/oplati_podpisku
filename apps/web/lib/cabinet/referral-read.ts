import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  getDb,
  ensureReferralCode,
  getPartnerProfile,
  getReferralBalanceUsdCents,
  getReferralNetwork,
  getReferralIncome,
  getReferralEarnings,
  getReferralMonthlyIncome,
  getNewReferralsThisMonth,
  getReferralLedger,
  getReferralPayouts,
} from '@oplati/db';
import {
  REFERRAL_RATE_TABLE,
  clampCircle,
  effectiveReferralRates,
} from '@oplati/types';

import { childLogger } from '../logger.ts';
import { telegramBotLink, telegramMiniAppLink } from '../telegram/links.ts';
import {
  ledgerToHistoryEntry,
  payoutToHistoryEntry,
  type ReferralSnapshot,
} from './referral-types.ts';

const log = childLogger('referral-cabinet');

const MONTHS_WINDOW = 6;
const HISTORY_LIMIT = 25;

/** Контекст вызова: личность/окружение, резолвится в роуте (initData или web). */
export type ReferralSnapshotContext = {
  /** Глобальный флаг `REFERRAL_ENABLED`. */
  enabled: boolean;
  /** Личность подтверждена Telegram (mini-app — всегда true; web — по профилю). */
  telegramLinked: boolean;
  /** Username бота для deep-link (единственный канал приглашения); null если недоступен. */
  botUsername: string | null;
  /**
   * Short name Mini App (BotFather /newapp). Задан → приглашение = прямая ссылка
   * на приложение `?startapp=ref_<code>` (код доезжает в мини-апп); null →
   * fallback на bot-deep-link `?start=ref_<code>` (только при нажатии «Начать»).
   */
  miniAppShortName: string | null;
  /** Минимум на вывод (USD-центы), `REFERRAL_MIN_PAYOUT_USD_CENTS`. */
  minPayoutUsdCents: number;
};

/** Ключи последних N месяцев (`YYYY-MM`, UTC) — под `to_char(date_trunc('month'…))`. */
function lastMonthKeys(n: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/** Пустой снапшот для выключенной программы (или дегрейда) — кабинет рисует заглушку. */
function disabledSnapshot(ctx: ReferralSnapshotContext): ReferralSnapshot {
  const top = REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1];
  return {
    enabled: false,
    suspended: false,
    telegramLinked: ctx.telegramLinked,
    referralCode: null,
    telegramLink: null,
    circle: {
      circle: 0,
      label: REFERRAL_RATE_TABLE[0]?.label ?? 'Клиент',
      nextLabel: REFERRAL_RATE_TABLE[1]?.label ?? null,
      nextThresholdUsdCents: REFERRAL_RATE_TABLE[1]?.thresholdUsdCents ?? null,
      achievementBonusUsdCents: 0,
    },
    rates: { l1Bps: 0, topL1Bps: top?.l1Bps ?? 0 },
    rateLockedForever: false,
    earnedThisMonthUsdCents: 0,
    earnedTotalUsdCents: 0,
    balanceUsdCents: 0,
    minPayoutUsdCents: ctx.minPayoutUsdCents,
    canPayout: false,
    progress: { networkTurnoverThisMonthUsdCents: 0, nextThresholdUsdCents: null, progressBps: 0 },
    sprint: {
      newReferralsThisMonth: 0,
      newReferralsActive: 0,
      newReferralsGoal: 10,
      turnoverThisMonthUsdCents: 0,
      turnoverBoostThresholdUsdCents: 0,
    },
    network: {
      total: 0,
      active: 0,
      turnoverThisMonthUsdCents: 0,
      incomeThisMonthUsdCents: 0,
      incomeAllTimeUsdCents: 0,
    },
    monthlyIncome: lastMonthKeys(MONTHS_WINDOW).map((month) => ({ month, usdCents: 0 })),
    history: [],
  };
}

/**
 * Формирует Telegram deep-link приглашения из реф-кода. Есть short name Mini App
 * → прямая ссылка на приложение (`?startapp=ref_`, код доезжает в мини-апп);
 * иначе — bot deep-link (`?start=ref_`, нужно нажать «Начать»). Нет кода или
 * bot-username → `null` (ссылку не показываем).
 */
export function formatReferralTelegramLink(
  referralCode: string | null,
  botUsername: string | null,
  miniAppShortName: string | null,
): string | null {
  if (!referralCode || !botUsername) return null;
  return miniAppShortName
    ? telegramMiniAppLink(botUsername, miniAppShortName, `ref_${referralCode}`)
    : telegramBotLink(botUsername, `ref_${referralCode}`);
}

/**
 * Лёгкий резолв реф-ссылки для ГЛАВНОГО меню мини-аппа (карточка «Скопировать»):
 * только `ensureReferralCode` + формат, без тяжёлого партнёрского снапшота
 * (сеть/доход/статусы). За флагом `REFERRAL_ENABLED` — иначе `null` (карточку не
 * рисуем). Graceful: сбой выдачи кода не валит снапшот кабинета (ссылка = null).
 */
export async function getReferralLinkForCabinet(
  userId: string,
  ctx: { enabled: boolean; botUsername: string | null; miniAppShortName: string | null },
): Promise<string | null> {
  if (!ctx.enabled) return null;
  let referralCode: string | null = null;
  try {
    referralCode = await ensureReferralCode(getDb(), userId);
  } catch (err) {
    log.error({ event: 'referral.cabinet.link_code_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.cabinet' } });
  }
  return formatReferralTelegramLink(referralCode, ctx.botUsername, ctx.miniAppShortName);
}

/**
 * Полный снимок партнёрского кабинета для `userId`. Одна реализация на обе
 * поверхности (веб-страница `/partner` + секция мини-аппа). Лениво выдаёт
 * реферальный код (`ensureReferralCode`) — это «пробуждение» программы для
 * данного пользователя (до первого открытия кабинета кода нет).
 *
 * Read-only по сути (кроме идемпотентной выдачи кода). Ставки/круги считаются
 * чистыми функциями @oplati/types, чтобы витрина и начисление не разъезжались.
 */
export async function buildReferralSnapshot(
  userId: string,
  ctx: ReferralSnapshotContext,
): Promise<ReferralSnapshot> {
  if (!ctx.enabled) return disabledSnapshot(ctx);

  const db = getDb();

  // Ленивая выдача кода — graceful: сбой не валит весь кабинет (код = null).
  let referralCode: string | null = null;
  try {
    referralCode = await ensureReferralCode(db, userId);
  } catch (err) {
    log.error({ event: 'referral.cabinet.code_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'referral.cabinet' } });
  }

  const [partner, balance, network, income, earnings, monthly, newRefs, ledger, payouts] =
    await Promise.all([
      getPartnerProfile(db, userId),
      getReferralBalanceUsdCents(db, userId),
      getReferralNetwork(db, userId),
      getReferralIncome(db, userId),
      getReferralEarnings(db, userId),
      getReferralMonthlyIncome(db, userId, MONTHS_WINDOW),
      getNewReferralsThisMonth(db, userId),
      getReferralLedger(db, userId, HISTORY_LIMIT),
      getReferralPayouts(db, userId, HISTORY_LIMIT),
    ]);

  const circle = clampCircle(partner?.circle ?? 0);
  const row = REFERRAL_RATE_TABLE[circle];
  const nextRow = REFERRAL_RATE_TABLE[circle + 1] ?? null;
  const top = REFERRAL_RATE_TABLE[REFERRAL_RATE_TABLE.length - 1];

  const rates = effectiveReferralRates({
    lockedRateL1Bps: partner?.lockedRateL1Bps ?? row?.l1Bps ?? 0,
    boostBps: partner?.boostBps ?? 0,
  });

  const networkView = {
    total: network.total,
    active: network.active,
    turnoverThisMonthUsdCents: network.turnoverThisMonthUsdCents,
    incomeThisMonthUsdCents: income.thisMonthUsdCents,
    incomeAllTimeUsdCents: income.allTimeUsdCents,
  };

  const networkTurnover = network.turnoverThisMonthUsdCents;
  const nextThreshold = nextRow?.thresholdUsdCents ?? null;
  const progressBps =
    nextThreshold && nextThreshold > 0
      ? Math.min(10000, Math.round((networkTurnover / nextThreshold) * 10000))
      : 10000;

  // База спринт-цели «150% плана»: порог текущего круга, а для Клиента (порог 0) —
  // следующий порог как осмысленный ориентир. Сами бонусы начисляет Этап C.
  const baseThreshold = (row?.thresholdUsdCents ?? 0) > 0 ? row!.thresholdUsdCents : nextThreshold ?? 0;

  const monthlyByKey = new Map(monthly.map((p) => [p.month, p.usdCents]));
  const monthlyIncome = lastMonthKeys(MONTHS_WINDOW).map((month) => ({
    month,
    usdCents: monthlyByKey.get(month) ?? 0,
  }));

  const history = [...ledger.map(ledgerToHistoryEntry), ...payouts.map(payoutToHistoryEntry)]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, HISTORY_LIMIT);

  const suspended = partner?.suspended ?? false;
  const canPayout = ctx.telegramLinked && !suspended && balance >= ctx.minPayoutUsdCents;

  // Приглашение — Telegram deep-link (short name Mini App → прямая ссылка на
  // приложение; иначе bot-deep-link). Формат общий с главным меню кабинета.
  const telegramLink = formatReferralTelegramLink(
    referralCode,
    ctx.botUsername,
    ctx.miniAppShortName,
  );

  return {
    enabled: true,
    suspended,
    telegramLinked: ctx.telegramLinked,
    referralCode,
    telegramLink,
    circle: {
      circle,
      label: row?.label ?? 'Клиент',
      nextLabel: nextRow?.label ?? null,
      nextThresholdUsdCents: nextThreshold,
      achievementBonusUsdCents: row?.achievementBonusUsdCents ?? 0,
    },
    rates: { l1Bps: rates.l1Bps, topL1Bps: top?.l1Bps ?? 0 },
    rateLockedForever: circle >= 1,
    earnedThisMonthUsdCents: earnings.thisMonthUsdCents,
    earnedTotalUsdCents: earnings.totalUsdCents,
    balanceUsdCents: balance,
    minPayoutUsdCents: ctx.minPayoutUsdCents,
    canPayout,
    progress: {
      networkTurnoverThisMonthUsdCents: networkTurnover,
      nextThresholdUsdCents: nextThreshold,
      progressBps,
    },
    sprint: {
      newReferralsThisMonth: newRefs.total,
      newReferralsActive: newRefs.active,
      newReferralsGoal: 10,
      turnoverThisMonthUsdCents: networkTurnover,
      turnoverBoostThresholdUsdCents: Math.round(baseThreshold * 1.5),
    },
    network: networkView,
    monthlyIncome,
    history,
  };
}
