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
    toRecycle: [] as CardLike[],
  },
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findCardsToRecycle: vi.fn(async () => h.state.toRecycle),
  markRecycled: vi.fn(async () => {}),
}));

// Алёрт баланса пишет персоналу (тикет 11). Здесь проверяется джоб, а не
// доставка: настоящая реализация полезла бы в базу и в env.
vi.mock('../alerts/notify-staff.ts', () => ({
  notifyStaff: vi.fn(async () => ({ delivered: 1, failed: 0, deduped: false })),
}));

// Пороги задаём явно: иначе тест зависит от окружения прогона, а не от того,
// что проверяет (`PAYSPACE_MIN_VCC_BALANCE_USD_CENTS` в env отменяет расчёт).
vi.mock('../env.server.ts', () => ({
  serverEnv: {
    PAYSPACE_MIN_VCC_BALANCE_USD_CENTS: 0,
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
    VCC_BALANCE_ALERT_DISABLED: false,
    CARD_LIFETIME_DAYS: 180,
  },
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
    h.state.toRecycle = [
      { id: 'card-1', providerCardId: 'pc-1' },
      { id: 'card-2', providerCardId: 'pc-2' },
    ];
    h.releaseMock.mockResolvedValue({ cardId: 'pc', releasedUsdCents: 0 });
    // «В норме» теперь означает «хватит и на самый дорогой заказ каталога»
    // ($1200 + буфер + fee), поэтому дефолт фикстуры выше прежнего.
    h.vccBalanceMock.mockResolvedValue({ balanceUsdCents: 200_000, pendingUsdCents: 0, currency: 'USD' });
  });

  it('happy path: release каждой карты + markRecycled', async () => {
    const res = await recycleCards();

    expect(res).toEqual({ recycled: 2, errors: 0 });
    expect(h.releaseMock).toHaveBeenCalledTimes(2);
    // Короткий детерминированный request_id (длинный PaySpace молча отклоняет).
    expect(h.releaseMock).toHaveBeenCalledWith('pc-1', expect.stringMatching(/^rel_[0-9a-f]{16}$/));
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

  it('PaySpace выключен → шаг release пропускаем, джоб не падает', async () => {
    h.paySpaceConfigured.value = false;

    const res = await recycleCards();

    expect(res.recycled).toBe(0);
    expect(res.errors).toBe(0);
    expect(db.findCardsToRecycle).not.toHaveBeenCalled();
    expect(h.releaseMock).not.toHaveBeenCalled();
    expect(h.vccBalanceMock).not.toHaveBeenCalled();
  });

  it('нехватка на типовой заказ — Sentry уровня error', async () => {
    // $10 на счету: не хватает даже на типовой заказ, то есть следующий
    // оплаченный заказ упадёт при выпуске карты. Это авария, а не «внимание».
    h.state.toRecycle = [];
    h.vccBalanceMock.mockResolvedValue({ balanceUsdCents: 1000, pendingUsdCents: 0, currency: 'USD' });

    await recycleCards();

    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('VCC balance'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('хватает на типовой, но не на самый дорогой — уровень warning', async () => {
    h.state.toRecycle = [];
    h.vccBalanceMock.mockResolvedValue({
      balanceUsdCents: 50_000,
      pendingUsdCents: 0,
      currency: 'USD',
    });

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
