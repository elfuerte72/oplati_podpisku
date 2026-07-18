import 'server-only';

import { syncCardBalance, type Card, type DB } from '@oplati/db';

import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';
import { childLogger } from '../logger.ts';

/**
 * Live-баланс основной карты для снапшота кабинета.
 *
 * Зачем: `cards.balance_usd_cents` — учётный снимок ТОЛЬКО наших движений
 * (topup при заказе, withdraw при release). Когда клиент платит подписку на
 * сайте сервиса, списание происходит на стороне PaySpace и в БД не попадает —
 * без синхронизации кабинет показывал бы завышенный баланс. Поэтому перед
 * отдачей снапшота тянем реальный баланс (`getCardInfo`) для карты, которую
 * кабинет показывает основной, и кэшируем его в БД.
 *
 * Деградация: сбой/медленный PaySpace НЕ роняет и НЕ тормозит кабинет — на
 * live-запрос выделен бюджет LIVE_BALANCE_BUDGET_MS (у клиента PaySpace свой
 * таймаут 60 с — для интерактивного экрана это слишком долго); не уложились —
 * отдаём последний известный снимок из БД.
 */

const log = childLogger('cabinet.live-balance');

/** Бюджет live-запроса баланса; дольше — отдаём БД-снимок. */
const LIVE_BALANCE_BUDGET_MS = 4_000;

/**
 * Карта, которую кабинет показывает основной: active, иначе самая свежая.
 * Обязано совпадать с выбором `primaryCard` в CabinetClient — live-баланс
 * тянем ровно для той карты, чей баланс увидит клиент.
 */
export function pickPrimaryCard(cards: Card[]): Card | null {
  return (
    cards.find((c) => c.status === 'active') ??
    [...cards].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
    null
  );
}

/** Race промиса с бюджетом времени: не уложился — null (запрос не отменяем). */
async function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Возвращает карты с актуальным балансом основной карты (и кэширует его в БД).
 * Любая неудача (PaySpace не настроен, сбой, таймаут бюджета) — исходный
 * список без изменений: показать последний известный баланс лучше, чем уронить
 * кабинет.
 */
export async function withLiveBalance(db: DB, cards: Card[]): Promise<Card[]> {
  const primary = pickPrimaryCard(cards);
  if (!primary || !isPaySpaceConfigured()) return cards;

  try {
    const info = await withBudget(
      getPaySpaceClient().getCardInfo(primary.providerCardId),
      LIVE_BALANCE_BUDGET_MS,
    );
    if (info === null) {
      log.warn({ event: 'cabinet.live_balance.budget_exceeded', cardId: primary.id });
      return cards;
    }
    if (info.balanceUsdCents === primary.balanceUsdCents) return cards;

    // Кэшируем свежее значение: даже если клиент больше не откроет кабинет,
    // следующий снимок (и алёрты по балансу) стартуют от реальности.
    await syncCardBalance(db, primary.id, info.balanceUsdCents, log);
    return cards.map((c) =>
      c.id === primary.id ? { ...c, balanceUsdCents: info.balanceUsdCents } : c,
    );
  } catch (err) {
    // Мягкая деградация (как readCardMetadataSafely в issue-card): предупреждение
    // в лог, кабинет живёт на БД-снимке. rawBody у PaySpace-ошибок redact'ится
    // логгером; секретов в getCardInfo нет (PAN приходит маской).
    log.warn({ event: 'cabinet.live_balance.failed', cardId: primary.id, err });
    return cards;
  }
}
