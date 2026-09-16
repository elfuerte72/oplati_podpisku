import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaidOrderNotice } from '@oplati/db';

const h = vi.hoisted(() => ({
  findNoticeMock: vi.fn((..._args: unknown[]) => Promise.resolve<unknown>(null)),
  notifyOpsMock: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
  captureMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findPaidOrderNotice: h.findNoticeMock,
}));
vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureMock }));

import { buildPaymentOpsMessage, notifyPaymentOps, PAYMENT_OPS_TITLE } from './notify-payment-ops.ts';

const NOW = new Date('2026-09-16T12:00:00Z');

function notice(over: Partial<PaidOrderNotice> = {}): PaidOrderNotice {
  return {
    orderId: 'o-1',
    shortId: 'ORD-7F3K2',
    status: 'paid',
    paidAt: NOW,
    amountKopecks: 200_000,
    cardIssueFeeKopecks: 0,
    promoDiscountKopecks: 0,
    bonusDiscountKopecks: 0,
    serviceName: 'Netflix',
    tierName: 'Standard',
    originalAmount: 1599,
    originalCurrency: 'USD',
    customDescription: null,
    client: {
      userId: 'u-1',
      displayName: 'Мария',
      telegramUsername: 'maria_pays',
      telegramId: '123',
      since: new Date('2026-08-01T00:00:00Z'),
      purchases: 3,
    },
    payment: { provider: 'freekassa', amountKopecks: 200_000, recoveredViaPolling: false, completedAt: NOW },
    ...over,
  };
}

/** Тысячи `toLocaleString` разделяет узким неразрывным пробелом (U+202F) — в ожиданиях пишем обычный. */
function fact(message: ReturnType<typeof buildPaymentOpsMessage>, label: string): string | undefined {
  return message.options.facts?.find((f) => f.label === label)?.value.replace(/[\u202f\u00a0]/g, " ");
}

describe('buildPaymentOpsMessage', () => {
  it('поток «Платежи», факты: заказ, клиент, покупка, что, сумма, провайдер; ссылка на заказ', () => {
    const m = buildPaymentOpsMessage(notice(), NOW);
    expect(m.options.stream).toBe('payments');
    expect(m.options.title).toBe(PAYMENT_OPS_TITLE);
    expect(m.options.facts?.map((f) => f.label)).toEqual([
      'Заказ',
      'Клиент',
      'Покупка',
      'Что',
      'Сумма',
      'Провайдер',
    ]);
    expect(fact(m, 'Заказ')).toBe('ORD-7F3K2');
    expect(fact(m, 'Клиент')).toBe('Мария (@maria_pays)');
    expect(fact(m, 'Покупка')).toBe('3-я, клиент с 01.08.2026');
    expect(fact(m, 'Что')).toBe('Netflix · Standard (15.99 USD)');
    expect(fact(m, 'Сумма')).toBe('2 000 ₽');
    expect(fact(m, 'Провайдер')).toBe('Freekassa, вебхук');
    expect(m.options.action).toEqual({ text: 'открыть заказ', path: '/admin/orders/ORD-7F3K2' });
  });

  it('скидка: счёт меньше цены — источник по строкам списаний', () => {
    const m = buildPaymentOpsMessage(
      notice({
        bonusDiscountKopecks: 40_500,
        payment: { provider: 'freekassa', amountKopecks: 159_500, recoveredViaPolling: true, completedAt: NOW },
      }),
      NOW,
    );
    expect(fact(m, 'Сумма')).toBe('1 595 ₽ (цена 2 000 ₽, баллы −405 ₽)');
    expect(fact(m, 'Провайдер')).toBe('Freekassa, подтверждён опросом');
  });

  it('промокод и баллы вместе; надбавка за карту — отдельной оговоркой', () => {
    const m = buildPaymentOpsMessage(
      notice({
        promoDiscountKopecks: 40_500,
        bonusDiscountKopecks: 10_000,
        cardIssueFeeKopecks: 32_400,
        payment: { provider: 'loveandpay', amountKopecks: 149_500, recoveredViaPolling: false, completedAt: NOW },
      }),
      NOW,
    );
    expect(fact(m, 'Сумма')).toBe('1 495 ₽ (цена 2 000 ₽, промокод + баллы −505 ₽), в т. ч. выпуск карты 324 ₽');
    expect(fact(m, 'Провайдер')).toBe('Love&Pay, вебхук');
  });

  it('счёт ниже цены без строк списаний — просто «скидка»', () => {
    const m = buildPaymentOpsMessage(
      notice({ payment: { provider: 'freekassa', amountKopecks: 190_000, recoveredViaPolling: false, completedAt: NOW } }),
      NOW,
    );
    expect(fact(m, 'Сумма')).toBe('1 900 ₽ (цена 2 000 ₽, скидка −100 ₽)');
  });

  it('клиент без username и без имени, заказ вне каталога, первая покупка, платёж не найден', () => {
    const m = buildPaymentOpsMessage(
      notice({
        serviceName: null,
        tierName: null,
        customDescription: 'Spotify семейный',
        originalAmount: null,
        client: {
          userId: 'u-2',
          displayName: null,
          telegramUsername: null,
          telegramId: '777',
          since: NOW,
          purchases: 1,
        },
        payment: null,
      }),
      NOW,
    );
    expect(fact(m, 'Клиент')).toBe('без имени (без username)');
    expect(fact(m, 'Покупка')).toBe('первая, клиент сегодняшний');
    expect(fact(m, 'Что')).toBe('Spotify семейный');
    expect(fact(m, 'Сумма')).toBe('2 000 ₽');
    expect(fact(m, 'Провайдер')).toBe('платёж в базе не найден');
  });

  it('веб-клиент без Telegram помечен как недостижимый в Telegram', () => {
    const m = buildPaymentOpsMessage(
      notice({ client: { ...notice().client, telegramUsername: null, telegramId: null } }),
      NOW,
    );
    expect(fact(m, 'Клиент')).toBe('Мария (сайт, без Telegram)');
  });
});

describe('notifyPaymentOps', () => {
  beforeEach(() => {
    h.findNoticeMock.mockReset();
    h.notifyOpsMock.mockClear();
    h.captureMock.mockClear();
  });

  it('шлёт в поток «Платежи» с фактами по заказу', async () => {
    h.findNoticeMock.mockResolvedValueOnce(notice());
    await notifyPaymentOps('o-1');
    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    const [body, opts] = h.notifyOpsMock.mock.calls[0] as [string, { stream: string; title: string }];
    expect(body).toBe('Деньги приняты, заказ ушёл в выпуск карты.');
    expect(opts.stream).toBe('payments');
    expect(opts.title).toBe(PAYMENT_OPS_TITLE);
    expect(h.captureMock).not.toHaveBeenCalled();
  });

  it('заказ не найден — ничего не шлёт и не бросает', async () => {
    h.findNoticeMock.mockResolvedValueOnce(null);
    await expect(notifyPaymentOps('o-x')).resolves.toBeUndefined();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
  });

  it('ошибка базы — лог + Sentry, не бросает (денежный путь не трогается)', async () => {
    h.findNoticeMock.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyPaymentOps('o-1')).resolves.toBeUndefined();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
    expect(h.captureMock).toHaveBeenCalledTimes(1);
  });
});
