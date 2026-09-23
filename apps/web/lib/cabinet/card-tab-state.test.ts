import { describe, expect, it } from 'vitest';

import {
  ISSUING_OVER_CARD_MAX_AGE_MS,
  NEXT_STEP_MAX_AGE_MS,
  selectCardTabState,
} from './card-tab-state.ts';

/**
 * Что показывает вкладка «Карта» (тикет 06). Главный риск — спрятать шаг 3
 * («оплати сервис этой картой») от того, кто его ещё не сделал, или вечно
 * показывать его тому, кто давно оформил подписку.
 */

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

type O = {
  orderId: string;
  status: string;
  createdAt: string;
  cardId?: string | null;
  subscriptionActivated?: boolean;
};
type C = { id: string; status: string; createdAt: string };

function order(overrides: Partial<O> & { orderId: string }): O {
  return {
    status: 'completed',
    createdAt: new Date(NOW - DAY).toISOString(),
    cardId: 'card-1',
    subscriptionActivated: false,
    ...overrides,
  };
}

function card(overrides: Partial<C> = {}): C {
  return { id: 'card-1', status: 'active', createdAt: new Date(NOW - 2 * DAY).toISOString(), ...overrides };
}

describe('selectCardTabState', () => {
  it('none — карт нет и выпускать нечего', () => {
    expect(selectCardTabState({ orders: [], cards: [] }, NOW)).toEqual({ kind: 'none' });
  });

  it('none — неоплаченный заказ карту ещё не обещает', () => {
    const state = selectCardTabState(
      { orders: [order({ orderId: 'o1', status: 'pending_payment', cardId: null })], cards: [] },
      NOW,
    );
    expect(state.kind).toBe('none');
  });

  it('issuing — оплаченный заказ без карты', () => {
    const paid = order({ orderId: 'o1', status: 'paid', cardId: null });
    const state = selectCardTabState({ orders: [paid], cards: [] }, NOW);
    expect(state).toEqual({ kind: 'issuing', order: paid, topUp: false });
  });

  it('issuing — заказ в выпуске, чья карта ещё не видна в кабинете', () => {
    const inWork = order({ orderId: 'o1', status: 'in_fulfillment', cardId: 'card-new' });
    const state = selectCardTabState({ orders: [inWork], cards: [] }, NOW);
    expect(state.kind).toBe('issuing');
  });

  it('issuing важнее готовой карты: второй сервис только что оплачен — topUp', () => {
    const paid = order({
      orderId: 'o2',
      status: 'paid',
      cardId: null,
      createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    const state = selectCardTabState(
      { orders: [paid, order({ orderId: 'o1', subscriptionActivated: true })], cards: [card()] },
      NOW,
    );
    expect(state).toEqual({ kind: 'issuing', order: paid, topUp: true });
  });

  it('застрявший выпуск не прячет рабочую карту бессрочно', () => {
    // Заказ завис в in_fulfillment (ручная выдача): через несколько часов
    // вкладка возвращается к рабочей карте, а не держит «Выпускаю…».
    const stuck = order({
      orderId: 'o2',
      status: 'in_fulfillment',
      cardId: null,
      createdAt: new Date(NOW - ISSUING_OVER_CARD_MAX_AGE_MS - 1).toISOString(),
    });
    const done = order({ orderId: 'o1', createdAt: new Date(NOW - 2 * DAY).toISOString() });
    const state = selectCardTabState({ orders: [stuck, done], cards: [card()] }, NOW);
    expect(state).toMatchObject({ kind: 'active', nextStep: done });
  });

  it('без рабочей карты застрявший выпуск показывается как есть — больше показать нечего', () => {
    const stuck = order({
      orderId: 'o2',
      status: 'in_fulfillment',
      cardId: null,
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
    });
    expect(selectCardTabState({ orders: [stuck], cards: [] }, NOW).kind).toBe('issuing');
  });

  it('active + nextStep — последний выполненный заказ по карте без отметки о подписке', () => {
    const done = order({ orderId: 'o1' });
    const state = selectCardTabState({ orders: [done], cards: [card()] }, NOW);
    expect(state).toEqual({ kind: 'active', card: card(), nextStep: done, cardOrders: [done] });
  });

  it('active без nextStep — подписка по последнему заказу отмечена', () => {
    const done = order({ orderId: 'o1', subscriptionActivated: true });
    const state = selectCardTabState({ orders: [done], cards: [card()] }, NOW);
    expect(state).toMatchObject({ kind: 'active', nextStep: null, cardOrders: [done] });
  });

  it('граница 14 дней: ровно 14 — ещё показываем, на миллисекунду старше — уже нет', () => {
    expect(NEXT_STEP_MAX_AGE_MS).toBe(14 * DAY);
    const edge = order({ orderId: 'o1', createdAt: new Date(NOW - 14 * DAY).toISOString() });
    expect(selectCardTabState({ orders: [edge], cards: [card()] }, NOW)).toMatchObject({
      nextStep: edge,
    });
    const stale = order({ orderId: 'o1', createdAt: new Date(NOW - 14 * DAY - 1).toISOString() });
    expect(selectCardTabState({ orders: [stale], cards: [card()] }, NOW)).toMatchObject({
      nextStep: null,
    });
  });

  it('решает ПОСЛЕДНИЙ заказ: старый без отметки не всплывает поверх нового с отметкой', () => {
    const older = order({ orderId: 'old', createdAt: new Date(NOW - 5 * DAY).toISOString() });
    const newer = order({ orderId: 'new', subscriptionActivated: true });
    const state = selectCardTabState({ orders: [older, newer], cards: [card()] }, NOW);
    expect(state).toMatchObject({ nextStep: null });
    // Заказы по карте — свежие сверху.
    expect(state.kind === 'active' && state.cardOrders.map((o) => o.orderId)).toEqual(['new', 'old']);
  });

  it('заказ без cardId к карте не относится: ни в шаге, ни в списке', () => {
    const orphan = order({ orderId: 'o1', cardId: null });
    const state = selectCardTabState({ orders: [orphan], cards: [card()] }, NOW);
    expect(state).toMatchObject({ kind: 'active', nextStep: null, cardOrders: [] });
  });

  it('старый снапшот без новых полей (деплой посреди сессии) — шаг не выдумывается', () => {
    const legacy = { orderId: 'o1', status: 'completed', createdAt: new Date(NOW - DAY).toISOString() };
    const state = selectCardTabState({ orders: [legacy], cards: [card()] }, NOW);
    expect(state).toMatchObject({ kind: 'active', nextStep: null, cardOrders: [] });
  });

  it('заказы по чужой карте клиента в список этой карты не попадают', () => {
    const other = order({ orderId: 'o1', cardId: 'card-old' });
    const state = selectCardTabState({ orders: [other], cards: [card()] }, NOW);
    expect(state).toMatchObject({ cardOrders: [], nextStep: null });
  });

  it('две активные карты — берём свежую по выпуску, а не первую в массиве', () => {
    const older = card({ id: 'old', createdAt: new Date(NOW - 9 * DAY).toISOString() });
    const newer = card({ id: 'new', createdAt: new Date(NOW - DAY).toISOString() });
    expect(selectCardTabState({ orders: [], cards: [older, newer] }, NOW)).toMatchObject({ card: newer });
  });

  it('основная карта — активная, а не самая свежая', () => {
    const idle = card({ id: 'card-2', status: 'idle', createdAt: new Date(NOW - DAY).toISOString() });
    const active = card({ id: 'card-1', status: 'active' });
    const state = selectCardTabState({ orders: [], cards: [idle, active] }, NOW);
    expect(state).toMatchObject({ kind: 'active', card: active });
  });

  it('активной нет — самая свежая по выпуску', () => {
    const a = card({ id: 'a', status: 'idle', createdAt: new Date(NOW - 9 * DAY).toISOString() });
    const b = card({ id: 'b', status: 'idle', createdAt: new Date(NOW - DAY).toISOString() });
    expect(selectCardTabState({ orders: [], cards: [a, b] }, NOW)).toMatchObject({ card: b });
  });
});
