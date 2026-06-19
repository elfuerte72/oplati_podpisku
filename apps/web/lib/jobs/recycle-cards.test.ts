import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.PAYSPACE_MIN_VCC_BALANCE_USD_CENTS = '5000';

type CardLike = { id: string; providerCardId: string };

const h = vi.hoisted(() => ({
  releaseMock: vi.fn(),
  vccBalanceMock: vi.fn(),
  paySpaceConfigured: { value: true },
  state: {
    idled: 0,
    toRecycle: [] as CardLike[],
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  idleAgedActiveCards: vi.fn(async () => h.state.idled),
  findCardsToRecycle: vi.fn(async () => h.state.toRecycle),
  markRecycled: vi.fn(async () => {}),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.paySpaceConfigured.value,
  getPaySpaceClient: () => ({
    releaseCard: h.releaseMock,
    getVccBalance: h.vccBalanceMock,
  }),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import * as db from '@oplati/db';
import { recycleCards } from './recycle-cards.ts';

describe('recycleCards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.paySpaceConfigured.value = true;
    h.state.idled = 2;
    h.state.toRecycle = [
      { id: 'card-1', providerCardId: 'pc-1' },
      { id: 'card-2', providerCardId: 'pc-2' },
    ];
    h.releaseMock.mockResolvedValue({ cardId: 'pc', releasedUsdCents: 0 });
    h.vccBalanceMock.mockResolvedValue({ balanceUsdCents: 100000, pendingUsdCents: 0, currency: 'USD' });
  });

  it('happy path: idle + release каждой карты + markRecycled', async () => {
    const res = await recycleCards();

    expect(res).toEqual({ idled: 2, recycled: 2, errors: 0 });
    expect(h.releaseMock).toHaveBeenCalledTimes(2);
    expect(h.releaseMock).toHaveBeenCalledWith('pc-1', 'recycle_card-1');
    expect(db.markRecycled).toHaveBeenCalledTimes(2);
    // баланс в норме — алёрта нет
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('ошибка release одной карты → её НЕ помечаем recycled, остальные обработаны', async () => {
    h.releaseMock
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ cardId: 'pc-2', releasedUsdCents: 0 });

    const res = await recycleCards();

    expect(res.recycled).toBe(1);
    expect(res.errors).toBe(1);
    expect(db.markRecycled).toHaveBeenCalledTimes(1);
    expect(db.markRecycled).toHaveBeenCalledWith(expect.anything(), 'card-2', expect.anything());
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it('PaySpace выключен → шаг release пропускаем, idle всё равно идёт', async () => {
    h.paySpaceConfigured.value = false;

    const res = await recycleCards();

    expect(res.idled).toBe(2);
    expect(res.recycled).toBe(0);
    expect(db.findCardsToRecycle).not.toHaveBeenCalled();
    expect(h.releaseMock).not.toHaveBeenCalled();
    expect(h.vccBalanceMock).not.toHaveBeenCalled();
  });

  it('низкий VCC-баланс → Sentry warning', async () => {
    h.state.toRecycle = [];
    h.vccBalanceMock.mockResolvedValue({ balanceUsdCents: 1000, pendingUsdCents: 0, currency: 'USD' });

    await recycleCards();

    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('VCC balance'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('сбой проверки баланса не валит джоб', async () => {
    h.state.toRecycle = [];
    h.vccBalanceMock.mockRejectedValue(new Error('balance api down'));

    const res = await recycleCards();

    expect(res.errors).toBe(0); // мониторинг не влияет на errors
    expect(sentry.captureException).toHaveBeenCalled();
  });
});
