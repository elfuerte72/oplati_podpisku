import { beforeEach, describe, expect, it, vi } from 'vitest';

type Ord = { id: string; userId: string; shortId: string; serviceId: string | null };

const state: { orders: Ord[]; telegramId: string | null } = { orders: [], telegramId: null };
const sendMessage = vi.fn<(chatId: string | number, text: string) => Promise<unknown>>();

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findOrdersForRenewalReminder: vi.fn(async () => state.orders),
  getUserTelegramId: vi.fn(async () => state.telegramId),
  getServiceById: vi.fn(async () => ({ name: 'Spotify' })),
  appendOrderEvent: vi.fn(async () => {}),
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage } }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as db from '@oplati/db';
import { sendRenewalReminders } from './subscription-renewal-reminder.ts';

describe('sendRenewalReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.orders = [];
    state.telegramId = '123456789012345'; // большой id — проверяем, что уходит строкой
  });

  it('шлёт напоминание строковым telegramId и пишет renewal_reminder_sent (M6 + L4)', async () => {
    state.orders = [{ id: 'o1', userId: 'u1', shortId: 'ORD-1', serviceId: 's1' }];

    const res = await sendRenewalReminders();

    expect(res).toEqual({ sent: 1, errors: 0 });

    // L4: chat_id передан СТРОКОЙ (не Number) — большие id не теряют точность.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const chatId = sendMessage.mock.calls[0]![0];
    expect(chatId).toBe('123456789012345');
    expect(typeof chatId).toBe('string');

    // M6: событие-дедуп записано после отправки → следующий прогон не повторит.
    expect(db.appendOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'o1', eventType: 'renewal_reminder_sent' }),
    );
  });

  it('нет telegramId → пропуск, ни отправки, ни события', async () => {
    state.telegramId = null;
    state.orders = [{ id: 'o1', userId: 'u1', shortId: 'ORD-1', serviceId: null }];

    const res = await sendRenewalReminders();

    expect(res.sent).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.appendOrderEvent).not.toHaveBeenCalled();
  });
});
