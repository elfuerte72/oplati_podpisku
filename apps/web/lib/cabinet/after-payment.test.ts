import { describe, expect, it } from 'vitest';

import {
  APP_RETURN_DEDUP_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  RATE_LIMITED_BACKOFF_MS,
  REVEAL_BACKGROUND_LIMIT_MS,
  afterPaymentOutcome,
  isDuplicateReturn,
  nextPollDelayMs,
  pollTargetOrderId,
  revealExpiredAfterBackground,
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

describe('pollTargetOrderId — чей заказ опрашивать', () => {
  it('ждём оплату открытого в листе заказа — его и опрашиваем', () => {
    expect(pollTargetOrderId({ orderId: 'A' }, 'A')).toBe('A');
  });

  it('лист закрыли или открыли другой заказ — не опрашиваем никого', () => {
    // Иначе ответы по A выбрасывались бы 10 минут, а лимит тратился.
    expect(pollTargetOrderId({ orderId: 'A' }, 'B')).toBeNull();
    expect(pollTargetOrderId({ orderId: 'A' }, null)).toBeNull();
  });

  it('оплату не ждём — не опрашиваем', () => {
    expect(pollTargetOrderId(null, 'A')).toBeNull();
  });
});

describe('nextPollDelayMs — отступ при 429', () => {
  it('обычный шаг — 5 секунд', () => {
    expect(nextPollDelayMs(null)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs('network_error')).toBe(POLL_INTERVAL_MS);
  });

  it('упёрлись в лимит — ждём дольше, а не долбим тем же шагом', () => {
    expect(nextPollDelayMs('rate_limited')).toBe(RATE_LIMITED_BACKOFF_MS);
    expect(RATE_LIMITED_BACKOFF_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('isDuplicateReturn — возврат в приложение приходит двумя событиями', () => {
  it('второе событие в пределах окна — дубль', () => {
    expect(isDuplicateReturn(10_000, 10_000 + APP_RETURN_DEDUP_MS - 1)).toBe(true);
  });

  it('за окном — новый возврат', () => {
    expect(isDuplicateReturn(10_000, 10_000 + APP_RETURN_DEDUP_MS)).toBe(false);
  });

  it('первого возврата ещё не было — не дубль', () => {
    expect(isDuplicateReturn(null, 5)).toBe(false);
  });
});

describe('revealExpiredAfterBackground — реквизиты в свёрнутом приложении', () => {
  it('короткий уход (скопировать и вставить на сайте) реквизиты не прячет', () => {
    expect(revealExpiredAfterBackground(0, REVEAL_BACKGROUND_LIMIT_MS)).toBe(false);
  });

  it('долгий уход — реквизиты прячутся до нового показа', () => {
    expect(revealExpiredAfterBackground(0, REVEAL_BACKGROUND_LIMIT_MS + 1)).toBe(true);
  });

  it('приложение не сворачивали — не прячем', () => {
    expect(revealExpiredAfterBackground(null, 999_999_999)).toBe(false);
  });
});
