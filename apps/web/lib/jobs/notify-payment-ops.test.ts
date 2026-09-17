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
vi.mock('../env.server.ts', () => ({ serverEnv: { PANEL_HOST: 'admin.example.test' } }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureMock }));

import { buildPaymentOpsMessage, notifyPaymentOps, PAYMENT_OPS_TITLE } from './notify-payment-ops.ts';

const NOW = new Date('2026-09-16T12:00:00Z');
const CTX = { now: NOW, panelHost: 'admin.example.test' };

function notice(over: Partial<PaidOrderNotice> = {}): PaidOrderNotice {
  return {
    shortId: 'ORD-7F3K2',
    status: 'in_fulfillment',
    amountKopecks: 200_000,
    cardIssueFeeKopecks: 0,
    promoDiscountKopecks: 0,
    bonusDiscountKopecks: 0,
    serviceName: 'Netflix',
    tierName: null,
    originalAmount: 1599,
    originalCurrency: 'USD',
    customDescription: null,
    client: {
      displayName: 'Мария',
      telegramUsername: 'maria_pays',
      telegramId: '123',
      since: new Date('2026-08-01T00:00:00Z'),
      purchases: 3,
    },
    payment: { provider: 'freekassa', amountKopecks: 200_000, recoveredViaPolling: false },
    ...over,
  };
}

/** Тысячи `toLocaleString` разделяет узким неразрывным пробелом (U+202F) — в ожиданиях пишем обычный. */
function fact(message: ReturnType<typeof buildPaymentOpsMessage>, label: string): string | undefined {
  return message.options.facts?.find((f) => f.label === label)?.value.replace(/[  ]/g, ' ');
}

describe('buildPaymentOpsMessage', () => {
  it('поток «Платежи», шесть фактов, тело по статусу и ссылка на заказ; хвоста «Что делать» нет', () => {
    const m = buildPaymentOpsMessage(notice(), CTX);
    expect(m.options.stream).toBe('payments');
    expect(m.options.title).toBe(PAYMENT_OPS_TITLE);
    expect(m.options.action).toBeUndefined();
    expect(m.options.facts?.map((f) => f.label)).toEqual(['Заказ', 'Клиент', 'Покупка', 'Что', 'Сумма', 'Провайдер']);
    expect(fact(m, 'Заказ')).toBe('ORD-7F3K2');
    expect(fact(m, 'Клиент')).toBe('@maria_pays');
    expect(fact(m, 'Покупка')).toBe('3-я, клиент с 01.08.2026');
    expect(fact(m, 'Что')).toBe('Netflix ($15.99)');
    expect(fact(m, 'Сумма')).toBe('2 000 ₽');
    expect(fact(m, 'Провайдер')).toBe('Freekassa, вебхук');
    expect(m.body).toBe('Деньги приняты, заказ в выпуске карты.\nhttps://admin.example.test/admin/orders/ORD-7F3K2');
  });

  it('тело зависит от статуса: paid, completed, failed, неизвестный', () => {
    const line = (status: string) => buildPaymentOpsMessage(notice({ status }), CTX).body.split('\n')[0];
    expect(line('paid')).toBe('Деньги приняты, выпуск карты ещё не начат.');
    expect(line('completed')).toBe('Деньги приняты, карта выдана.');
    expect(line('failed')).toBe('Деньги приняты, выпуск карты не удался — разбор по алёрту в теме «Авария».');
    expect(line('refund_requested')).toBe('Деньги приняты.');
  });

  it('скидка: счёт меньше цены — источник по строкам списаний; опрос крона помечен', () => {
    const m = buildPaymentOpsMessage(
      notice({
        bonusDiscountKopecks: 40_500,
        payment: { provider: 'freekassa', amountKopecks: 159_500, recoveredViaPolling: true },
      }),
      CTX,
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
        payment: { provider: 'loveandpay', amountKopecks: 149_500, recoveredViaPolling: false },
      }),
      CTX,
    );
    expect(fact(m, 'Сумма')).toBe('1 495 ₽ (цена 2 000 ₽, промокод + баллы −505 ₽), в т. ч. выпуск карты 324 ₽');
    expect(fact(m, 'Провайдер')).toBe('Love&Pay, вебхук');
  });

  it('счёт ниже цены без строк списаний — просто «скидка»', () => {
    const m = buildPaymentOpsMessage(
      notice({ payment: { provider: 'freekassa', amountKopecks: 190_000, recoveredViaPolling: false } }),
      CTX,
    );
    expect(fact(m, 'Сумма')).toBe('1 900 ₽ (цена 2 000 ₽, скидка −100 ₽)');
  });

  it('клиент без username — имя; без имени — «без имени»; заказ вне каталога; первая покупка', () => {
    const named = buildPaymentOpsMessage(
      notice({ client: { ...notice().client, telegramUsername: null } }),
      CTX,
    );
    expect(fact(named, 'Клиент')).toBe('Мария');
    const m = buildPaymentOpsMessage(
      notice({
        serviceName: null,
        customDescription: 'Spotify семейный',
        originalAmount: null,
        client: { displayName: null, telegramUsername: null, telegramId: '777', since: NOW, purchases: 1 },
      }),
      CTX,
    );
    expect(fact(m, 'Клиент')).toBe('без имени');
    expect(fact(m, 'Покупка')).toBe('первая, клиент сегодняшний');
    expect(fact(m, 'Что')).toBe('Spotify семейный');
  });

  it('веб-клиент без Telegram помечен прямо', () => {
    const m = buildPaymentOpsMessage(
      notice({ client: { ...notice().client, telegramUsername: null, telegramId: null } }),
      CTX,
    );
    expect(fact(m, 'Клиент')).toBe('Мария, сайт без Telegram');
  });

  it('«сегодняшний» — по московскому дню, а не по 24 часам', () => {
    // Регистрация 15.09 23:30 МСК (20:30 UTC), оплата 16.09 10:00 МСК — прошло 10,5 часов, но день другой.
    const since = new Date('2026-09-15T20:30:00Z');
    const now = new Date('2026-09-16T07:00:00Z');
    const m = buildPaymentOpsMessage(notice({ client: { ...notice().client, since, purchases: 1 } }), { now, panelHost: null });
    expect(fact(m, 'Покупка')).toBe('первая, клиент с 15.09.2026');
    // Регистрация 16.09 00:30 МСК (15.09 21:30 UTC), оплата тем же московским днём — сегодняшний.
    const m2 = buildPaymentOpsMessage(
      notice({ client: { ...notice().client, since: new Date('2026-09-15T21:30:00Z'), purchases: 1 } }),
      { now, panelHost: null },
    );
    expect(fact(m2, 'Покупка')).toBe('первая, клиент сегодняшний');
  });

  it('без хоста панели ссылка — относительный путь', () => {
    const m = buildPaymentOpsMessage(notice(), { now: NOW, panelHost: null });
    expect(m.body.split('\n')[1]).toBe('/admin/orders/ORD-7F3K2');
  });
});

describe('notifyPaymentOps', () => {
  beforeEach(() => {
    h.findNoticeMock.mockReset();
    h.notifyOpsMock.mockReset().mockResolvedValue(true);
    h.captureMock.mockClear();
  });

  it('шлёт в поток «Платежи» с фактами по заказу', async () => {
    h.findNoticeMock.mockResolvedValueOnce(notice());
    await notifyPaymentOps('o-1');
    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    const [body, opts] = h.notifyOpsMock.mock.calls[0] as [string, { stream: string; title: string }];
    expect(body).toContain('https://admin.example.test/admin/orders/ORD-7F3K2');
    expect(opts.stream).toBe('payments');
    expect(opts.title).toBe(PAYMENT_OPS_TITLE);
    expect(h.captureMock).not.toHaveBeenCalled();
  });

  it('карточка не найдена — ничего не шлёт и не бросает', async () => {
    h.findNoticeMock.mockResolvedValueOnce(null);
    await expect(notifyPaymentOps('o-x')).resolves.toBeUndefined();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
  });

  it('доставка не состоялась — не бросает (факт не сохраняется, добора нет)', async () => {
    h.findNoticeMock.mockResolvedValueOnce(notice());
    h.notifyOpsMock.mockResolvedValueOnce(false);
    await expect(notifyPaymentOps('o-1')).resolves.toBeUndefined();
    expect(h.captureMock).not.toHaveBeenCalled();
  });

  it('ошибка базы — лог + Sentry, не бросает (денежный путь не трогается)', async () => {
    h.findNoticeMock.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyPaymentOps('o-1')).resolves.toBeUndefined();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
    expect(h.captureMock).toHaveBeenCalledTimes(1);
  });
});
