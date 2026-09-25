import { describe, expect, it } from 'vitest';

import { selectCardTabState } from '@/lib/cabinet/card-tab-state';

import { orderSummarySchema } from './cabinet-api';

/**
 * Сквозной путь «сводка заказа с сервера → zod-схема Mini App → вкладка
 * «Карта»». Правило `isPaidButIssueFailed` читает `paidAt`, а схема сводки
 * поля не знала и zod его отрезал: ветка «Карта задерживается» была мёртвой,
 * хотя тесты `card-tab-state` зелёные — их фикстуры поле добавляли сами
 * (ревью 2026-09-25, ось D).
 */
describe('orderSummarySchema', () => {
  const serverSummary = {
    orderId: 'o-1',
    shortId: 'ORD-AAAAA',
    status: 'failed',
    statusLabel: 'Ошибка',
    service: 'ChatGPT',
    amountKopecks: 3000_00,
    createdAt: '2026-09-25T10:00:00.000Z',
    expiresAt: null,
    payable: false,
    bonus: null,
    promo: null,
    cardId: null,
    subscriptionActivated: false,
    paidAt: '2026-09-25T10:05:00.000Z',
  };

  it('не отрезает paidAt, и вкладка «Карта» видит сорванную выдачу', () => {
    const parsed = orderSummarySchema.parse(serverSummary);

    expect(parsed.paidAt).toBe('2026-09-25T10:05:00.000Z');
    const state = selectCardTabState(
      { orders: [parsed], cards: [] },
      Date.parse('2026-09-25T11:00:00.000Z'),
    );
    expect(state).toMatchObject({ kind: 'issue_failed', order: { orderId: 'o-1' } });
  });

  it('снапшот прошлого деплоя без paidAt разбирается и не выдумывает сбой', () => {
    const { paidAt: _paidAt, ...legacy } = serverSummary;
    void _paidAt;
    const parsed = orderSummarySchema.parse(legacy);

    expect(parsed.paidAt).toBeUndefined();
    expect(selectCardTabState({ orders: [parsed], cards: [] })).toEqual({ kind: 'none' });
  });
});
