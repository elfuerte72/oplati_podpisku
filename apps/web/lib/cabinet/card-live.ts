/**
 * Слияние живого баланса карты со снапшотом кабинета. Снапшот приходит из БД
 * сразу, живой ответ PaySpace (`card-live`) — следом, и подменяет у одной
 * карты ровно два поля: баланс и «Действует до».
 */

import type { CardLiveView } from './types.ts';

type CardFields = { id: string; balanceUsdCents: number; validUntil: string };

/**
 * Как часто кабинет сам спрашивает живой баланс. Запрос стоит ~1,2 с у
 * провайдера и место в бакете `cabinet` (30 в минуту), а баланс меняется
 * только от оплаты на сайте сервиса. Возврат в приложение — исключение: клиент
 * мог только что оплатить подписку, и ждать ему незачем.
 */
export const CARD_LIVE_MIN_INTERVAL_MS = 15_000;

/**
 * Снапшот с живыми полями карты. Тот же объект, если карты в снапшоте нет или
 * поля уже совпадают: новая ссылка перерисовала бы вкладки впустую.
 */
export function applyCardLive<S extends { cards: readonly CardFields[] }>(snapshot: S, live: CardLiveView): S {
  const card = snapshot.cards.find((c) => c.id === live.cardId);
  if (!card) return snapshot;
  if (card.balanceUsdCents === live.balanceUsdCents && card.validUntil === live.validUntil) return snapshot;
  return {
    ...snapshot,
    cards: snapshot.cards.map((c) =>
      c.id === live.cardId ? { ...c, balanceUsdCents: live.balanceUsdCents, validUntil: live.validUntil } : c,
    ),
  };
}

/** Пора ли спросить живой баланс: не чаще `CARD_LIVE_MIN_INTERVAL_MS`, кроме `force`. */
export function shouldRefreshCardLive(lastAt: number | null, now: number, force: boolean): boolean {
  if (force || lastAt === null) return true;
  return now - lastAt >= CARD_LIVE_MIN_INTERVAL_MS;
}
