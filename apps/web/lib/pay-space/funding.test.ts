import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Одна формула «сколько снимется с карточного фонда ради этого заказа»
 * (тикет 01 трека vcc-preflight).
 *
 * До неё формула жила в двух местах — в сумме фондирования карты и в пороге
 * алёрта, — и расхождение ловилось только внимательностью правящего. Числа
 * ниже взяты из инцидента 2026-08-14: заказ на $100 при буфере 20% и комиссии
 * $4 требовал $124, а на счёте лежало $89.50.
 */

const h = vi.hoisted(() => ({
  env: {
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
  } as Record<string, unknown>,
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({}, { get: (_t, prop: string) => h.env[prop] }),
}));

import { isCardReusable, orderFundingRequirementUsdCents } from './funding.ts';

beforeEach(() => {
  h.env = { PAYSPACE_CARD_BUFFER_PERCENT: 20, CARD_ISSUE_FEE_USD_CENTS: 400 };
});

describe('orderFundingRequirementUsdCents', () => {
  it('новому клиенту нужна цена с буфером плюс комиссия за выпуск', () => {
    // $100 + 20% = $120 на карту, плюс $4 комиссии провайдера = $124.
    expect(orderFundingRequirementUsdCents({ priceUsdCents: 10_000, needsNewCard: true })).toBe(
      12_400,
    );
  });

  it('клиенту с живой картой комиссия за выпуск не нужна — только долив', () => {
    // Та же цена дешевле фонду ровно на комиссию: провайдер берёт её за выпуск,
    // а не за пополнение.
    expect(orderFundingRequirementUsdCents({ priceUsdCents: 10_000, needsNewCard: false })).toBe(
      12_000,
    );
  });

  it('буфер округляется ВВЕРХ до цента и комиссия добавляется после округления', () => {
    // $9.99 x 1.2 = $11.988 -> $11.99, плюс $4 = $15.99. Округление вниз дало бы
    // карту дешевле реального charge — ровно та экономия, ради которой заведён буфер.
    expect(orderFundingRequirementUsdCents({ priceUsdCents: 999, needsNewCard: true })).toBe(1599);
  });

  it('без буфера требование равно цене плюс комиссия', () => {
    h.env.PAYSPACE_CARD_BUFFER_PERCENT = 0;

    expect(orderFundingRequirementUsdCents({ priceUsdCents: 10_000, needsNewCard: true })).toBe(
      10_400,
    );
  });

  it('невалидная цена отвергается, а не превращается в NaN на пути к деньгам', () => {
    expect(() => orderFundingRequirementUsdCents({ priceUsdCents: -1, needsNewCard: true })).toThrow();
    expect(() =>
      orderFundingRequirementUsdCents({ priceUsdCents: 100.5, needsNewCard: true }),
    ).toThrow();
  });
});

describe('isCardReusable', () => {
  const NOW = new Date('2026-08-19T12:00:00Z');
  const cardAgedDays = (days: number) => ({
    createdAt: new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000),
  });

  it('карты нет — переиспользовать нечего, будет выпуск новой', () => {
    expect(isCardReusable(null, NOW)).toBe(false);
  });

  it('свежая карта переиспользуется — это долив без комиссии за выпуск', () => {
    expect(isCardReusable(cardAgedDays(1), NOW)).toBe(true);
  });

  it('карта в последние сутки жизни доливу не подлежит', () => {
    // Её закроет ночной `recycle-cards` необратимым release, и деньги клиента
    // вернутся на наш VCC — подписка свернётся (аудит 2026-08-10, HIGH).
    expect(isCardReusable(cardAgedDays(179.5), NOW)).toBe(false);
  });
});
