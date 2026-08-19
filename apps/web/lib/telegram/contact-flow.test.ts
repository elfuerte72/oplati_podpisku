import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

/**
 * Контакт-флоу бота (тикет 06): номер собирается reply-кнопкой request_contact,
 * счёт выставляется после контакта. Ключевая защита — чужой контакт из
 * адресной книги отвергается (`contact.user_id !== from.id`).
 */

const h = vi.hoisted(() => ({
  updateContactsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  lastMetaMock: vi.fn((..._args: unknown[]) => Promise.resolve(null as Record<string, unknown> | null)),
  persistMock: vi.fn((..._args: unknown[]) =>
    Promise.resolve({ userId: 'user-1', conversationId: 'conv-1' } as {
      userId: string;
      conversationId: string;
    } | null),
  ),
  appendMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  sendMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  confirmMock: vi.fn((..._args: unknown[]) => Promise.resolve({
    paymentUrl: 'https://pay/1',
    qrPayload: null,
    expiresAt: '2026-08-16T12:00:00.000Z',
  })),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getLastAssistantMessageMeta: h.lastMetaMock,
  updateUserContacts: h.updateContactsMock,
}));
vi.mock('./persist', () => ({
  persistInbound: h.persistMock,
  safeAppendMessage: h.appendMock,
}));
vi.mock('./send', () => ({ sendSafely: h.sendMock }));
vi.mock('@/lib/payments/gateway', () => ({ currentBuyerFeePercent: () => 0 }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/tool-handlers/confirm-order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-handlers/confirm-order')>();
  return { ...actual, confirmOrder: h.confirmMock };
});

import { AWAITING_CONTACT_META_KEY, handleContactMessage } from './contact-flow.ts';

function contactUpdate(contact: {
  phone_number: string;
  user_id?: number;
}): { update: TelegramUpdate; message: TelegramMessage } {
  const message = {
    message_id: 10,
    chat: { id: 100, type: 'private' },
    from: { id: 555, first_name: 'Тест' },
    contact,
  } as unknown as TelegramMessage;
  return { update: { update_id: 1, message } as unknown as TelegramUpdate, message };
}

const sentTexts = () => h.sendMock.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks();
  h.persistMock.mockResolvedValue({ userId: 'user-1', conversationId: 'conv-1' });
  h.lastMetaMock.mockResolvedValue(null);
  h.confirmMock.mockResolvedValue({
    paymentUrl: 'https://pay/1',
    qrPayload: null,
    expiresAt: '2026-08-16T12:00:00.000Z',
  });
});

describe('handleContactMessage', () => {
  it('чужой контакт из адресной книги отвергается — номер НЕ сохраняется', async () => {
    const { update, message } = contactUpdate({ phone_number: '+79991234567', user_id: 999 });

    await handleContactMessage(update, message);

    expect(h.updateContactsMock).not.toHaveBeenCalled();
    expect(sentTexts().join(' ')).toContain('чужой');
  });

  it('контакт без user_id (номер вне Telegram) тоже отвергается', async () => {
    const { update, message } = contactUpdate({ phone_number: '+79991234567' });

    await handleContactMessage(update, message);

    expect(h.updateContactsMock).not.toHaveBeenCalled();
  });

  it('свой контакт: номер нормализуется и сохраняется с источником telegram', async () => {
    // Telegram может отдать номер без плюса — код страны в нём уже есть.
    const { update, message } = contactUpdate({ phone_number: '79991234567', user_id: 555 });

    await handleContactMessage(update, message);

    expect(h.updateContactsMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1',
      phone: '+79991234567',
      phoneSource: 'telegram',
    });
    // Без pending-заказа — «сохранён, нажми оплатить ещё раз», счёт не выставляется.
    expect(h.confirmMock).not.toHaveBeenCalled();
    expect(sentTexts().join(' ')).toContain('сохранён');
  });

  it('pending-заказ: после контакта выставляется счёт и уходит ссылка', async () => {
    h.lastMetaMock.mockResolvedValue({ [AWAITING_CONTACT_META_KEY]: 'order-42' });
    const { update, message } = contactUpdate({ phone_number: '+79991234567', user_id: 555 });

    await handleContactMessage(update, message);

    expect(h.confirmMock).toHaveBeenCalledWith({ orderId: 'order-42', userId: 'user-1' });
    expect(sentTexts().join(' ')).toContain('https://pay/1');
  });

  it('сбой выставления счёта не теряет номер — честный текст вместо ссылки', async () => {
    h.lastMetaMock.mockResolvedValue({ [AWAITING_CONTACT_META_KEY]: 'order-42' });
    h.confirmMock.mockRejectedValueOnce(new Error('провайдер лежит'));
    const { update, message } = contactUpdate({ phone_number: '+79991234567', user_id: 555 });

    await handleContactMessage(update, message);

    expect(h.updateContactsMock).toHaveBeenCalledTimes(1);
    const all = sentTexts().join(' ');
    expect(all).toContain('Номер сохранён');
    expect(all).not.toContain('провайдер лежит');
  });
});

describe('счёт после контакта — карту выпустить нечем (тикет 02 vcc-preflight)', () => {
  it('клиент слышит честный срок, а не «попробуй через минуту», и Sentry не шумит', async () => {
    // Самый вероятный путь этого отказа: телефон спрашивают от 10 000 ₽, а
    // инцидентный заказ был на 11 680 ₽. Генерик «через минуту» тут враньё —
    // карточный счёт пополняется T+1.
    const { PaymentCapacityError } = await import('@/lib/tool-handlers/confirm-order');
    const Sentry = await import('@sentry/nextjs');
    h.lastMetaMock.mockResolvedValue({ [AWAITING_CONTACT_META_KEY]: 'order-1' });
    h.confirmMock.mockRejectedValueOnce(new PaymentCapacityError(43));

    const { update, message } = contactUpdate({ phone_number: '+79001234567', user_id: 555 });
    await handleContactMessage(update, message);

    const text = sentTexts().join('\n');
    expect(text).toContain('Номер сохранён');
    expect(text).toContain('43 минуты');
    expect(text).not.toContain('через минуту');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
