import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Кнопка «Подтвердить» в боте — тот же денежный путь, что веб-подтверждение,
 * но его отказы до 2026-08-12 не разбирались: `confirm_order` аккуратно
 * классифицирует 409/422/503, а бот сваливал всё, кроме лимита суммы, в текст
 * «я уже подключил оператора». Оператора эта ветка не зовёт (в коде только
 * Sentry), то есть клиент ждал контакта, которого не будет (находка ревью).
 */

const h = vi.hoisted(() => ({
  confirmOrder: vi.fn(),
  sendSafely: vi.fn(async (..._args: unknown[]) => undefined),
  resolveCallbackContext: vi.fn(
    async (): Promise<{ userId: string; conversationId: string } | null> => ({
      userId: 'user-1',
      conversationId: 'conv-1',
    }),
  ),
  editMessageReplyMarkup: vi.fn(async () => undefined),
  captureException: vi.fn(),
}));

vi.mock('@/lib/tool-handlers/confirm-order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-handlers/confirm-order')>();
  return { ...actual, confirmOrder: h.confirmOrder };
});

vi.mock('./send', () => ({
  sendSafely: h.sendSafely,
  showOrEdit: vi.fn(async () => undefined),
  withTypingIndicator: async (_chatId: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('./persist', () => ({
  resolveCallbackContext: h.resolveCallbackContext,
  safeAppendMessage: vi.fn(async () => undefined),
}));

vi.mock('./bot', () => ({
  getBot: () => ({ api: { editMessageReplyMarkup: h.editMessageReplyMarkup } }),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => null),
  transitionOrder: vi.fn(async () => undefined),
}));

vi.mock('@/lib/payments/gateway', () => ({ currentBuyerFeePercent: () => 0 }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import { PROVIDER_UNAVAILABLE_TEXT } from '@/lib/loveandpay/availability';
import {
  OrderAboveMaxAmountError,
  PaymentCapacityError,
  OrderExpiredError,
  PaymentProviderUnavailableError,
} from '@/lib/tool-handlers/confirm-order';

import { handleOrderActionCallback } from './catalog-callbacks.ts';

const cb = { id: 'cb1', from: { id: 555 }, message: { message_id: 9 } } as never;

function sentText(): string {
  return (h.sendSafely.mock.calls.at(-1)?.[1] ?? '') as string;
}

async function confirmWith(err: unknown): Promise<string> {
  h.confirmOrder.mockRejectedValueOnce(err);
  await handleOrderActionCallback(cb, 555, 'confirm', 'order-1', 42);
  return sentText();
}

beforeEach(() => {
  h.confirmOrder.mockReset().mockResolvedValue({
    paymentUrl: 'https://pay.example.com/i/abc',
    qrPayload: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  h.sendSafely.mockClear();
  h.resolveCallbackContext.mockClear().mockResolvedValue({
    userId: 'user-1',
    conversationId: 'conv-1',
  });
  h.captureException.mockClear();
});

describe('успешное подтверждение', () => {
  it('ссылка оплаты уходит клиенту, ownership делегирован confirmOrder', async () => {
    await handleOrderActionCallback(cb, 555, 'confirm', 'order-1', 42);
    expect(h.confirmOrder).toHaveBeenCalledWith({ orderId: 'order-1', userId: 'user-1' });
    expect(sentText()).toContain('https://pay.example.com/i/abc');
  });

  it('недоступная БД не даёт подтвердить заказ по непроверенному владельцу', async () => {
    h.resolveCallbackContext.mockResolvedValueOnce(null);
    await handleOrderActionCallback(cb, 555, 'confirm', 'order-1', 42);
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });
});

describe('разбор отказов: клиенту говорят то, что есть на самом деле', () => {
  it('протухшая фиксация цены → «оформи заново», без обещания оператора', async () => {
    const text = await confirmWith(new OrderExpiredError());
    expect(text).toContain('заново');
    expect(text).not.toContain('оператор');
  });

  it('транспорт до шлюза лежит → общий текст «сбой, заказ сохранён»', async () => {
    const text = await confirmWith(new PaymentProviderUnavailableError());
    expect(text).toBe(PROVIDER_UNAVAILABLE_TEXT);
  });

  it('выше лимита шлюза → конкретная цифра', async () => {
    const text = await confirmWith(new OrderAboveMaxAmountError(140000));
    expect(text).toContain('140');
  });

  it('карту выпустить нечем → заказ цел и путь дальше, без внутренностей', async () => {
    const text = await confirmWith(new PaymentCapacityError(43));
    expect(text).toMatch(/заказ сохранён/i);
    expect(text).toContain('поддержку');
    expect(text).not.toMatch(/баланс|фонд|PaySpace/i);
  });

  it('неизвестная ошибка → честный повтор и /support, без выдуманного оператора', async () => {
    const text = await confirmWith(new Error('что-то пошло не так'));
    expect(text).toContain('/support');
    expect(text).not.toContain('подключил оператора');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('ни один отказ не выдаёт ссылку оплаты', async () => {
    for (const err of [
      new OrderExpiredError(),
      new PaymentProviderUnavailableError(),
      new OrderAboveMaxAmountError(null),
      new PaymentCapacityError(43),
      new Error('boom'),
    ]) {
      const text = await confirmWith(err);
      expect(text).not.toContain('pay.example.com');
    }
  });
});
