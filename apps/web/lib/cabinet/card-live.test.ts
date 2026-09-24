import { describe, expect, it } from 'vitest';

import { CARD_LIVE_MIN_INTERVAL_MS, applyCardLive, shouldRefreshCardLive } from './card-live.ts';

/**
 * Живой баланс карты приходит после снапшота и подменяет два поля одной
 * карты. Ошибка здесь видна клиенту сразу: чужой карте достался бы чужой
 * баланс, или лишняя новая ссылка перерисовывала бы вкладки на каждый ответ.
 */

const card = (over: Record<string, unknown> = {}) => ({
  id: 'card-1',
  panMasked: '•••• 1726',
  balanceUsdCents: 2000,
  validUntil: '2027-03-20T20:59:59.000Z',
  purpose: 'ChatGPT',
  ...over,
});

describe('applyCardLive', () => {
  it('подменяет баланс и срок только у своей карты, остальное не трогает', () => {
    const other = card({ id: 'card-2', balanceUsdCents: 700 });
    const snapshot = { orders: [], cards: [card(), other] };

    const next = applyCardLive(snapshot, { cardId: 'card-1', balanceUsdCents: 315, validUntil: '2027-01-31T20:59:59.000Z' });

    expect(next.cards[0]).toEqual({ ...card(), balanceUsdCents: 315, validUntil: '2027-01-31T20:59:59.000Z' });
    expect(next.cards[1]).toBe(other);
    expect(next.orders).toBe(snapshot.orders);
  });

  it('значения совпали — тот же объект, без лишней перерисовки', () => {
    const snapshot = { cards: [card()] };
    const same = applyCardLive(snapshot, { cardId: 'card-1', balanceUsdCents: 2000, validUntil: '2027-03-20T20:59:59.000Z' });
    expect(same).toBe(snapshot);
  });

  it('карты с таким id в снапшоте нет — тот же объект', () => {
    const snapshot = { cards: [card()] };
    expect(applyCardLive(snapshot, { cardId: 'card-9', balanceUsdCents: 1, validUntil: 'x' })).toBe(snapshot);
  });
});

describe('shouldRefreshCardLive', () => {
  it('первый раз — да', () => {
    expect(shouldRefreshCardLive(null, 1000, false)).toBe(true);
  });

  it('раньше интервала — нет, после — да', () => {
    expect(shouldRefreshCardLive(0, CARD_LIVE_MIN_INTERVAL_MS - 1, false)).toBe(false);
    expect(shouldRefreshCardLive(0, CARD_LIVE_MIN_INTERVAL_MS, false)).toBe(true);
  });

  it('возврат в приложение (force) — да, даже сразу после прошлого', () => {
    expect(shouldRefreshCardLive(1000, 1001, true)).toBe(true);
  });
});
