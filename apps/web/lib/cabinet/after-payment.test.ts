import { describe, expect, it } from 'vitest';

import {
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  afterPaymentOutcome,
  shouldPoll,
  shouldWatchIssuing,
} from './after-payment.ts';

/**
 * Что делает Mini App после того, как клиент ушёл на страницу оплаты (тикет 08).
 * Опрос стоит денег лимита (бакет `cabinet` — 30 запросов в минуту на клиента)
 * и батареи, поэтому ходим только тогда, когда ответ может что-то поменять.
 */

describe('константы опроса', () => {
  it('раз в 5 секунд, не дольше 10 минут — 12 запросов в минуту из 30', () => {
    expect(POLL_INTERVAL_MS).toBe(5_000);
    expect(POLL_MAX_MS).toBe(10 * 60 * 1000);
    expect(60_000 / POLL_INTERVAL_MS).toBeLessThanOrEqual(12);
  });
});

describe('shouldPoll — ждём подтверждения оплаты', () => {
  it('опрашиваем заказ в pending_payment при видимой вкладке', () => {
    expect(shouldPoll('pending_payment', 0, true)).toBe(true);
    expect(shouldPoll('pending_payment', POLL_MAX_MS - 1, true)).toBe(true);
  });

  it('только в pending_payment: другой статус — опрос окончен', () => {
    for (const status of [
      'ready_for_payment',
      'paid',
      'in_fulfillment',
      'completed',
      'payment_review',
      'expired',
      'cancelled',
      'failed',
    ]) {
      expect(shouldPoll(status, 1000, true)).toBe(false);
    }
  });

  it('скрытое приложение не опрашивает — вернётся, перечитаем сразу', () => {
    expect(shouldPoll('pending_payment', 1000, false)).toBe(false);
  });

  it('стоп на 10 минутах', () => {
    expect(shouldPoll('pending_payment', POLL_MAX_MS, true)).toBe(false);
    expect(shouldPoll('pending_payment', POLL_MAX_MS + 1, true)).toBe(false);
  });
});

describe('shouldWatchIssuing — ждём карту после оплаты', () => {
  it('следим, пока заказ оплачен или в выпуске', () => {
    expect(shouldWatchIssuing('paid', 0, true)).toBe(true);
    expect(shouldWatchIssuing('in_fulfillment', 1000, true)).toBe(true);
  });

  it('карта выдана или выпуск сорвался — слежка окончена', () => {
    expect(shouldWatchIssuing('completed', 1000, true)).toBe(false);
    expect(shouldWatchIssuing('failed', 1000, true)).toBe(false);
  });

  it('фон и 10 минут — стоп, как у опроса оплаты', () => {
    expect(shouldWatchIssuing('paid', 1000, false)).toBe(false);
    expect(shouldWatchIssuing('paid', POLL_MAX_MS, true)).toBe(false);
  });
});

describe('afterPaymentOutcome — что делать с новым статусом', () => {
  it('оплачен или в выпуске — на «Карту», выпуск', () => {
    expect(afterPaymentOutcome('paid')).toBe('to_card');
    expect(afterPaymentOutcome('in_fulfillment')).toBe('to_card');
  });

  it('карта уже выдана — на «Карту», шаг 3', () => {
    expect(afterPaymentOutcome('completed')).toBe('to_card');
  });

  it('банк держит платёж — лист остаётся, без перехода', () => {
    expect(afterPaymentOutcome('payment_review')).toBe('stay');
  });

  it('всё ещё ждём оплату — лист остаётся', () => {
    expect(afterPaymentOutcome('pending_payment')).toBe('stay');
  });

  it('истёк/отменён/ошибка — лист остаётся и показывает статус', () => {
    expect(afterPaymentOutcome('expired')).toBe('stay');
    expect(afterPaymentOutcome('failed')).toBe('stay');
  });
});
