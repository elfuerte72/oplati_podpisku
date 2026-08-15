import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Привязка Telegram + handoff заказа — денежный флоу без прямых тестов до
 * аудита 2026-08-10. Здесь сходятся два обещания:
 *   1. привязка не должна врать: неудачное потребление токена не может
 *      выглядеть успехом (клиент уйдёт с сайта и не получит ни чек, ни карту);
 *   2. handoff — best-effort: он ВЫСТАВЛЯЕТ СЧЁТ, но его сбой не имеет права
 *      уронить саму привязку.
 */

const h = vi.hoisted(() => ({
  consumeLinkToken: vi.fn(),
  getOrdersByUserId: vi.fn(async () => [] as unknown[]),
  confirmOrder: vi.fn(),
  sendSafely: vi.fn(async (..._args: unknown[]) => undefined),
  persistInbound: vi.fn(
    async (): Promise<{ userId: string; conversationId: string } | null> => ({
      userId: 'u1',
      conversationId: 'c1',
    }),
  ),
  safeAppendMessage: vi.fn(async (..._args: unknown[]) => undefined),
  captureException: vi.fn(),
  askContact: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  consumeLinkToken: h.consumeLinkToken,
  getOrdersByUserId: h.getOrdersByUserId,
  LINK_TOKEN_PREFIX: 'link_',
}));

// Классы ошибок — настоящие (instanceof в catch link-flow), подменяем только вызов.
vi.mock('@/lib/tool-handlers/confirm-order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-handlers/confirm-order')>();
  return { ...actual, confirmOrder: h.confirmOrder };
});
vi.mock('./contact-flow', () => ({ askForContactBeforeInvoice: h.askContact }));
vi.mock('./send', () => ({ sendSafely: h.sendSafely }));
vi.mock('./persist', () => ({
  persistInbound: h.persistInbound,
  safeAppendMessage: h.safeAppendMessage,
}));
vi.mock('@/lib/payments/gateway', () => ({ currentBuyerFeePercent: () => 0 }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import { handleLinkDeepLink } from './link-flow.ts';

const update = { update_id: 42 } as never;
const message = {
  message_id: 7,
  chat: { id: 555, type: 'private' },
  from: { id: 379336096, is_bot: false, first_name: 'Иван' },
  text: '/start link_abc',
} as never;

function readyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    shortId: 'ORD-AB12',
    status: 'ready_for_payment',
    amountRub: 249000,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Текст, который бот реально отправил клиенту. */
function sentText(): string {
  return (h.sendSafely.mock.calls.at(-1)?.[1] ?? '') as string;
}

beforeEach(() => {
  h.consumeLinkToken.mockReset().mockResolvedValue({ ok: true, userId: 'u1', merged: false });
  h.getOrdersByUserId.mockReset().mockResolvedValue([]);
  h.confirmOrder.mockReset().mockResolvedValue({
    paymentUrl: 'https://pay.example.com/i/abc',
    qrPayload: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  h.sendSafely.mockClear();
  h.persistInbound.mockClear().mockResolvedValue({ userId: 'u1', conversationId: 'c1' });
  h.safeAppendMessage.mockClear();
  h.captureException.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('потребление токена', () => {
  it('токен передаётся без префикса link_', async () => {
    await handleLinkDeepLink(update, message, 'link_abc123');
    expect(h.consumeLinkToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 'abc123', telegramId: '379336096' }),
      expect.anything(),
    );
  });

  it('имя собирается из first_name + last_name', async () => {
    const withLast = { ...(message as object), from: { id: 1, first_name: 'Иван', last_name: 'Петров' } };
    await handleLinkDeepLink(update, withLast as never, 'link_abc');
    expect(h.consumeLinkToken.mock.calls[0]?.[1]).toMatchObject({ displayName: 'Иван Петров' });
  });

  it('протухший/использованный токен → честный текст «ссылка устарела»', async () => {
    h.consumeLinkToken.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).toContain('устарела');
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('сбой БД НЕ выдаётся за успешную привязку', async () => {
    // «Готово, Telegram привязан» при непривязанном Telegram — это клиент,
    // который уходит с сайта и не получает ни чек, ни реквизиты карты.
    h.consumeLinkToken.mockRejectedValueOnce(new Error('connection refused'));
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).not.toContain('привязан!');
    expect(sentText()).toContain('Попробуй ещё раз');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('апдейт без from.id не потребляет токен (иначе он сгорел бы впустую)', async () => {
    const noFrom = { ...(message as object), from: undefined };
    await handleLinkDeepLink(update, noFrom as never, 'link_abc');
    expect(h.consumeLinkToken).not.toHaveBeenCalled();
    expect(sentText()).toContain('Попробуй ещё раз');
  });
});

describe('handoff заказа: счёт выставляется прямо в боте', () => {
  it('свежий ready_for_payment → счёт создан, ссылка в сообщении', async () => {
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder()]);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.confirmOrder).toHaveBeenCalledWith({ orderId: 'order-1', userId: 'u1' });
    expect(sentText()).toContain('https://pay.example.com/i/abc');
    expect(sentText()).toContain('ORD-AB12');
  });

  it('QR упоминается только когда провайдер его прислал', async () => {
    h.getOrdersByUserId.mockResolvedValue([readyOrder()]);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).not.toContain('QR');

    h.confirmOrder.mockResolvedValueOnce({
      paymentUrl: 'https://pay/1',
      qrPayload: 'qr-data',
      expiresAt: new Date().toISOString(),
    });
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).toContain('QR');
  });

  it('заказа нет → обычный успех-текст, счёт не выставляется', async () => {
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.confirmOrder).not.toHaveBeenCalled();
    expect(sentText()).toContain('привязан!');
  });

  it('брошенный черновик старше суток не воскрешается', async () => {
    h.getOrdersByUserId.mockResolvedValueOnce([
      readyOrder({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
    ]);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('заказ в другом статусе не оплачивается автоматически', async () => {
    h.getOrdersByUserId.mockResolvedValueOnce([
      readyOrder({ status: 'pending_payment' }),
      readyOrder({ id: 'o2', status: 'completed' }),
    ]);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('заказ без суммы пропускается (счёт на 0 ₽ выставлять нечем)', async () => {
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder({ amountRub: null })]);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.confirmOrder).not.toHaveBeenCalled();
  });

  it('сумма от порога без номера: счёт НЕ выставляется, бот просит контакт', async () => {
    // Тикет 06: handoff не выставляет счёт до получения номера — вместо ссылки
    // оплаты уходит reply-кнопка request_contact (счёт выставит contact-flow).
    const { PhoneRequiredError } = await import('@/lib/tool-handlers/confirm-order');
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder()]);
    h.confirmOrder.mockRejectedValueOnce(new PhoneRequiredError(10_000));

    await handleLinkDeepLink(update, message, 'link_abc');

    expect(h.confirmOrder).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('привязан');
    expect(h.askContact).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', thresholdRub: 10_000 }),
    );
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('заказ без почты в профиле → подсказка про кабинет, а не тишина', async () => {
    // Переходное окно антифрод-трека: заказ оформлен в вебе ДО плашки
    // контактов, email_required ловится и превращается в понятный шаг.
    const { EmailRequiredError } = await import('@/lib/tool-handlers/confirm-order');
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder()]);
    h.confirmOrder.mockRejectedValueOnce(new EmailRequiredError());
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).toContain('привязан');
    expect(sentText()).toContain('почт');
    // Ожидаемый бизнес-кейс, не сбой — Sentry не шумит.
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('сбой выставления счёта НЕ роняет привязку', async () => {
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder()]);
    h.confirmOrder.mockRejectedValueOnce(new Error('провайдер лежит'));
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(sentText()).toContain('привязан!');
    expect(sentText()).not.toContain('провайдер лежит');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('зависший провайдер не держит подтверждение привязки дольше 15 с', async () => {
    vi.useFakeTimers();
    h.getOrdersByUserId.mockResolvedValueOnce([readyOrder()]);
    h.confirmOrder.mockImplementationOnce(() => new Promise(() => {}));

    const done = handleLinkDeepLink(update, message, 'link_abc');
    await vi.advanceTimersByTimeAsync(15_000);
    await done;

    expect(sentText()).toContain('привязан!');
    expect(sentText()).not.toContain('pay.example.com');
  });
});

describe('персист диалога', () => {
  it('пишется ПОСЛЕ потребления токена (иначе upsert создаст лишнюю строку до merge)', async () => {
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.consumeLinkToken.mock.invocationCallOrder[0]!).toBeLessThan(
      h.persistInbound.mock.invocationCallOrder[0]!,
    );
  });

  it('недоступная БД для истории не мешает ответить клиенту', async () => {
    h.persistInbound.mockResolvedValueOnce(null);
    await handleLinkDeepLink(update, message, 'link_abc');
    expect(h.safeAppendMessage).not.toHaveBeenCalled();
    expect(h.sendSafely).toHaveBeenCalled();
  });
});
