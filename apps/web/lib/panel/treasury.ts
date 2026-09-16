import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb } from '@oplati/db';
import { FREEKASSA_WITHDRAWAL_METHODS, parseRubleAmountToKopecks } from '@oplati/types';

import { getFreekassaClient, isFreekassaConfigured, isFreekassaUnavailable } from '@/lib/freekassa';
import { childLogger } from '@/lib/logger';
import { getPaySpaceClient, isPaySpaceConfigured } from '@/lib/pay-space';
import type { AccountBalanceEntry } from '@/lib/pay-space/client';
import { summarizeFundCommitments, type FundCommitments } from '@/lib/pay-space/preflight';

import { isSlowProviderError, readVccBalanceForPanel, type PanelVccBalance } from './vcc-balance';

/**
 * Раздел «Финансы» (трек treasury, тикет 01): остатки на трёх счетах и что из
 * карточного фонда свободно — на одном экране.
 *
 * Зачем: пополнение карточного счёта идёт цепочкой через три кабинета (касса
 * Freekassa → FKWallet → крипто-кошелёк PaySpace → карточный субаккаунт), и
 * до этого экрана владелец видел в панели только последнее звено. Решение
 * «пополнять ли сегодня» принимается по ВСЕЙ цепочке: сколько рублей уже
 * лежит на кассе, сколько USDT ждёт на крипто-кошельке, сколько в пути.
 *
 * Правила те же, что у остатка на рабочем столе (`vcc-balance.ts`):
 *   - никогда не бросает — недоступный провайдер даёт «данные не получены», а
 *     не пятисотку вместо экрана;
 *   - у каждого провайдера свой короткий поводок и кэш на минуту: страница
 *     справочная, а Freekassa к тому же тратит на каждый запрос nonce из
 *     общей очереди с платёжными вызовами;
 *   - устаревшее число лучше прочерка, но с временем получения; старше
 *     получаса — прочерк.
 *
 * ⚠️ Ничего не мутирует и мутировать не будет: кнопка перевода — отдельный
 * тикет с отдельной операцией под гейтом `Origin`.
 */

const log = childLogger('panel.treasury');

/** Бюджет одной фазы запроса к провайдеру, один заход. */
const READ_TIMEOUT_MS = 3000;
/**
 * Сколько ждём очереди Freekassa. У крона — минута, но экран столько не
 * держит: очередь занята — покажем прежнее число.
 */
const QUEUE_WAIT_MS = 5000;
const CACHE_TTL_MS = 60_000;
const STALE_MAX_MS = 30 * 60_000;
/** Сколько последних выводов показывать. */
const WITHDRAWALS_SHOWN = 10;

export type ProviderReading<T> =
  | { state: 'ok'; readAt: Date; data: T }
  /** Свежее значение не получено, недавнее есть — показываем его с пометкой. */
  | { state: 'stale'; readAt: Date; data: T }
  | { state: 'not_configured' }
  | { state: 'unavailable' };

export type FreekassaBalanceRow = {
  currency: string;
  /** Копейки — только у RUB; прочие валюты показываются сырой строкой. */
  amountKopecks: number | null;
  raw: string;
};

export type FreekassaWithdrawalRow = {
  id: string;
  currency: string;
  amountKopecks: number | null;
  raw: string;
  methodId: number;
  /** Имя способа из справочника провайдера; `null` — код вне справочника. */
  methodName: string | null;
  date: string | null;
  status: number;
};

export type FreekassaTreasury = {
  balances: FreekassaBalanceRow[];
  withdrawals: FreekassaWithdrawalRow[];
};

export type PaySpaceCryptoTreasury = {
  balances: AccountBalanceEntry[];
  totalUsdCents: number;
};

export type TreasuryReport = {
  vcc: PanelVccBalance;
  fund: ({ state: 'ok' } & FundCommitments) | { state: 'unavailable' };
  /**
   * Остаток карточного счёта минус обязательства. Может быть ОТРИЦАТЕЛЬНЫМ
   * (обещано больше, чем лежит) — клампом наружу занимается экран, а дыру
   * целиком надо показать. `null` — остаток или обязательства не прочитаны.
   */
  freeUsdCents: number | null;
  payspace: ProviderReading<PaySpaceCryptoTreasury>;
  freekassa: ProviderReading<FreekassaTreasury>;
};

/** Есть ли на кошельке что-то, кроме нулей. Пустые кошельки экран прячет. */
export function hasFunds(entry: Pick<AccountBalanceEntry, 'amount' | 'fiatUsdCents'>): boolean {
  return Number(entry.amount) > 0 || entry.fiatUsdCents > 0;
}

/**
 * Кэш одного провайдера с правилом «свежее — прежнее с пометкой — прочерк».
 * Свой экземпляр на провайдера: отказ Freekassa не должен прятать цифры PaySpace.
 */
class CachedProviderReading<T> {
  private cached: { data: T; readAt: number } | null = null;

  constructor(private readonly provider: 'payspace' | 'freekassa') {}

  reset(): void {
    this.cached = null;
  }

  async read(
    configured: boolean,
    fetcher: () => Promise<T>,
    now: Date,
  ): Promise<ProviderReading<T>> {
    if (!configured) return { state: 'not_configured' };

    const nowMs = now.getTime();
    if (this.cached && nowMs - this.cached.readAt < CACHE_TTL_MS) {
      return { state: 'ok', readAt: new Date(this.cached.readAt), data: this.cached.data };
    }

    try {
      const data = await fetcher();
      this.cached = { data, readAt: nowMs };
      return { state: 'ok', readAt: new Date(nowMs), data };
    } catch (err) {
      // Медленный или лежащий провайдер — обычное дело и не повод для Sentry
      // с каждой открытой вкладки; дрейф контракта и отказ по существу —
      // повод (та же развилка, что у остатка на рабочем столе).
      if (isSlowProviderError(err) || isFreekassaUnavailable(err)) {
        log.warn({ event: 'panel.treasury.slow', provider: this.provider, timeoutMs: READ_TIMEOUT_MS });
      } else {
        log.warn({ event: 'panel.treasury.unavailable', provider: this.provider, err });
        Sentry.captureException(err, {
          tags: { source: 'panel.treasury', provider: this.provider },
        });
      }
      if (this.cached && nowMs - this.cached.readAt < STALE_MAX_MS) {
        return { state: 'stale', readAt: new Date(this.cached.readAt), data: this.cached.data };
      }
      return { state: 'unavailable' };
    }
  }
}

const paySpaceReading = new CachedProviderReading<PaySpaceCryptoTreasury>('payspace');
const freekassaReading = new CachedProviderReading<FreekassaTreasury>('freekassa');

/** Только для тестов: сбросить кэши между сценариями. */
export function resetTreasuryCacheForTests(): void {
  paySpaceReading.reset();
  freekassaReading.reset();
}

async function fetchPaySpaceCrypto(): Promise<PaySpaceCryptoTreasury> {
  const result = await getPaySpaceClient().getBalances({
    timeoutMs: READ_TIMEOUT_MS,
    attempts: 1,
  });
  // Оценка запрошена в USD; пришла в другой валюте — это не «просто число»,
  // а разъезд с тем, что экран называет долларами.
  if (result.fiatCurrency !== 'USD') {
    throw new Error(`PaySpace оценил кошельки в ${result.fiatCurrency}, а запрошены USD`);
  }
  return { balances: result.balances, totalUsdCents: result.totalUsdCents };
}

async function fetchFreekassa(): Promise<FreekassaTreasury> {
  const client = getFreekassaClient();
  const opts = { timeoutMs: READ_TIMEOUT_MS, queueWaitMs: QUEUE_WAIT_MS };
  // Два запроса встают в общую очередь друг за другом; nonce у каждого свой.
  const [balance, withdrawals] = await Promise.all([
    client.getBalance(opts),
    client.listWithdrawals(opts),
  ]);
  return {
    balances: balance.map((row) => ({
      currency: row.currency,
      raw: row.value,
      amountKopecks: row.currency === 'RUB' ? parseRubleAmountToKopecks(row.value) : null,
    })),
    withdrawals: withdrawals.slice(0, WITHDRAWALS_SHOWN).map((w) => ({
      id: w.id,
      currency: w.currency,
      raw: w.amount,
      amountKopecks: w.currency === 'RUB' ? parseRubleAmountToKopecks(w.amount) : null,
      methodId: w.ext_currency_id,
      methodName: FREEKASSA_WITHDRAWAL_METHODS[w.ext_currency_id] ?? null,
      date: w.date ?? null,
      status: w.status,
    })),
  };
}

/**
 * Обязательства фонда — из базы, той же арифметикой, что у гейта оплаты.
 * Без кэша: это два запроса к своей базе, а не поход наружу.
 */
async function readFund(now: Date): Promise<TreasuryReport['fund']> {
  try {
    const commitments = await summarizeFundCommitments(getDb(), now);
    return { state: 'ok', ...commitments };
  } catch (err) {
    log.warn({ event: 'panel.treasury.fund_unavailable', err });
    Sentry.captureException(err, { tags: { source: 'panel.treasury', step: 'fund' } });
    return { state: 'unavailable' };
  }
}

export async function readTreasuryForPanel(now: Date = new Date()): Promise<TreasuryReport> {
  const [vcc, fund, payspace, freekassa] = await Promise.all([
    readVccBalanceForPanel(now),
    readFund(now),
    paySpaceReading.read(isPaySpaceConfigured(), fetchPaySpaceCrypto, now),
    freekassaReading.read(isFreekassaConfigured(), fetchFreekassa, now),
  ]);

  const freeUsdCents =
    (vcc.state === 'ok' || vcc.state === 'stale') && fund.state === 'ok'
      ? vcc.balanceUsdCents -
        fund.committedUsdCents -
        fund.reservedUsdCents -
        fund.safetyReserveUsdCents
      : null;

  return { vcc, fund, freeUsdCents, payspace, freekassa };
}
