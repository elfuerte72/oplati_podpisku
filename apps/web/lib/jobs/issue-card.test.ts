import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type OrderLike = {
  id: string;
  userId: string;
  status: string;
  originalAmount: number | null;
  shortId: string;
};

const h = vi.hoisted(() => ({
  topupMock: vi.fn(),
  createCardMock: vi.fn(),
  sendMessageMock: vi.fn(),
  paySpaceConfigured: { value: true },
  dbState: {
    order: null as OrderLike | null,
    claimTransitioned: true,
    activeCard: null as Record<string, unknown> | null,
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrderById: vi.fn(async () => h.dbState.order),
  transitionOrderDetailed: vi.fn(async (_db: unknown, input: { toStatus: string }) => ({
    order: { ...(h.dbState.order ?? {}), status: input.toStatus },
    transitioned: h.dbState.claimTransitioned,
  })),
  transitionOrder: vi.fn(async () => ({})),
  findActiveByUserId: vi.fn(async () => h.dbState.activeCard),
  findRecyclableCard: vi.fn(async () => null),
  createCard: vi.fn(async () => ({ id: 'card-new', providerCardId: 'pc-new', panMasked: '****1234' })),
  markActive: vi.fn(async () => {}),
  updateBalance: vi.fn(async () => {}),
  setOrderCardId: vi.fn(async () => {}),
  getUserTelegramId: vi.fn(async () => '12345'),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.paySpaceConfigured.value,
  getPaySpaceClient: () => ({
    topupCard: h.topupMock,
    createCard: h.createCardMock,
    getCard: vi.fn(),
  }),
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as db from '@oplati/db';
import { issueCard } from './issue-card.ts';

const baseOrder: OrderLike = {
  id: 'order-1',
  userId: 'user-1',
  status: 'paid',
  originalAmount: 2000, // $20.00
  shortId: 'ORD-AAAAA',
};

const activeCard = {
  id: 'card-1',
  userId: 'user-1',
  provider: 'paypace',
  providerCardId: 'pc-1',
  panMasked: '****1111',
  status: 'active',
  balanceUsdCents: 0,
  lastUsedAt: null,
  recycledAt: null,
  createdAt: new Date(),
};

describe('issueCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.paySpaceConfigured.value = true;
    h.dbState.order = { ...baseOrder };
    h.dbState.claimTransitioned = true;
    h.dbState.activeCard = { ...activeCard };
    h.topupMock.mockResolvedValue({ balanceUsdCents: 2000 });
  });

  it('happy path: claim успешен, активная карта → ровно один топ-ап', async () => {
    await issueCard('order-1');

    expect(db.transitionOrderDetailed).toHaveBeenCalledTimes(1);
    expect(h.topupMock).toHaveBeenCalledTimes(1);
    expect(h.topupMock).toHaveBeenCalledWith({ cardId: 'pc-1', amountUsdCents: 2000 });
    expect(db.updateBalance).toHaveBeenCalledTimes(1);
    // in_fulfillment → completed (claim уже сделал paid → in_fulfillment).
    expect(db.transitionOrder).toHaveBeenCalledTimes(1);
  });

  it('идемпотентность: claim проигран (transitioned=false) → НЕТ топ-апа (нет двойной траты)', async () => {
    h.dbState.claimTransitioned = false;

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).toHaveBeenCalledTimes(1);
    expect(h.topupMock).not.toHaveBeenCalled();
    expect(h.createCardMock).not.toHaveBeenCalled();
    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transitionOrder).not.toHaveBeenCalled();
  });

  it('PaySpace выключен → ранний выход ДО claim, заказ остаётся в paid', async () => {
    h.paySpaceConfigured.value = false;

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).not.toHaveBeenCalled();
    expect(h.topupMock).not.toHaveBeenCalled();
  });

  it('статус не paid → ранний выход, claim не дёргается', async () => {
    h.dbState.order = { ...baseOrder, status: 'completed' };

    await issueCard('order-1');

    expect(db.transitionOrderDetailed).not.toHaveBeenCalled();
    expect(h.topupMock).not.toHaveBeenCalled();
  });

  it('новая карта: claim успешен, активной нет → createCard + реквизиты в Telegram', async () => {
    h.dbState.activeCard = null;
    h.createCardMock.mockResolvedValue({
      cardId: 'pc-new',
      panMasked: '****1234',
      pan: '4111111111111234',
      expMonth: 12,
      expYear: 2030,
      cvc: '123',
      balanceUsdCents: 2000,
    });

    await issueCard('order-1');

    expect(h.createCardMock).toHaveBeenCalledTimes(1);
    expect(h.topupMock).not.toHaveBeenCalled();
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(db.transitionOrder).toHaveBeenCalledTimes(1); // → completed
  });
});
