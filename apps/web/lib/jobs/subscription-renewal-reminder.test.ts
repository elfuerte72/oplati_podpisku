import { beforeEach, describe, expect, it, vi } from 'vitest';

type Ord = { id: string; userId: string; shortId: string; serviceId: string | null };

const state: { orders: Ord[]; telegramId: string | null; claim: boolean } = {
  orders: [],
  telegramId: null,
  claim: true,
};
const sendMessage = vi.fn<(chatId: string | number, text: string) => Promise<unknown>>();
const claimRenewalReminder = vi.fn(async () => state.claim);

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findOrdersForRenewalReminder: vi.fn(async () => state.orders),
  getUserTelegramId: vi.fn(async () => state.telegramId),
  getServiceById: vi.fn(async () => ({ name: 'Spotify' })),
  claimRenewalReminder: (...args: unknown[]) => claimRenewalReminder(...(args as [])),
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage } }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { sendRenewalReminders } from './subscription-renewal-reminder.ts';

describe('sendRenewalReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.orders = [];
    state.telegramId = '123456789012345'; // большой id — проверяем, что уходит строкой
    state.claim = true;
  });

  it('шлёт напоминание строковым telegramId, заняв право на отправку (M6 + L4 + B-2)', async () => {
    state.orders = [{ id: 'o1', userId: 'u1', shortId: 'ORD-1', serviceId: 's1' }];

    const res = await sendRenewalReminders();

    expect(res).toEqual({ sent: 1, errors: 0 });

    // L4: chat_id передан СТРОКОЙ (не Number) — большие id не теряют точность.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const chatId = sendMessage.mock.calls[0]![0];
    expect(chatId).toBe('123456789012345');
    expect(typeof chatId).toBe('string');

    // B-2: право занято ДО отправки — иначе два одновременных прогона джоба
    // отправили бы оба и только потом обнаружили конфликт.
    expect(claimRenewalReminder).toHaveBeenCalledWith(expect.anything(), 'o1');
    expect(claimRenewalReminder.mock.invocationCallOrder[0]!).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
  });

  it('право занял конкурент → ни отправки, ни ошибки', async () => {
    state.claim = false;
    state.orders = [{ id: 'o1', userId: 'u1', shortId: 'ORD-1', serviceId: 's1' }];

    const res = await sendRenewalReminders();

    expect(res).toEqual({ sent: 0, errors: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('нет telegramId → пропуск: ни claim, ни отправки', async () => {
    state.telegramId = null;
    state.orders = [{ id: 'o1', userId: 'u1', shortId: 'ORD-1', serviceId: null }];

    const res = await sendRenewalReminders();

    expect(res.sent).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    // Занимать право, не имея куда слать, нельзя: заказ навсегда остался бы
    // «уведомлённым», хотя клиент ничего не получил.
    expect(claimRenewalReminder).not.toHaveBeenCalled();
  });
});
