import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

type ServiceLike = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  pricingPolicy: unknown;
};

const h = vi.hoisted(() => ({
  service: null as ServiceLike | null,
  proposeImpl: vi.fn(),
  appendMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getServiceBySlug: vi.fn(async () => h.service),
  appendMessage: (...args: unknown[]) => h.appendMock(...args),
}));

vi.mock('@/lib/tool-handlers/propose-order', () => {
  class OrderAmountOutOfBoundsError extends Error {}
  class OrderCapExceededError extends Error {}
  class OrderBelowMinimumError extends Error {}
  return {
    OrderAmountOutOfBoundsError,
    OrderCapExceededError,
    OrderBelowMinimumError,
    proposeOrder: (input: unknown) => h.proposeImpl(input),
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import {
  OrderAmountOutOfBoundsError,
  OrderBelowMinimumError,
  OrderCapExceededError,
} from '@/lib/tool-handlers/propose-order';

import { proposeFromCatalog } from './propose.ts';

const tierService: ServiceLike = {
  id: 'svc-1',
  slug: 'claude-pro',
  name: 'Claude Pro',
  isActive: true,
  pricingPolicy: {
    tiers: [{ name: 'Pro', period: 'month', priceRub: 253_000, originalAmount: 2000, currency: 'USD' }],
  },
};

const multiPeriodService: ServiceLike = {
  id: 'svc-3',
  slug: 'playstation-plus',
  name: 'PlayStation Plus',
  isActive: true,
  pricingPolicy: {
    tiers: [
      { name: 'Essential', period: 'month', priceRub: 1, originalAmount: 1099, currency: 'USD' },
      { name: 'Essential', period: 'quarter', priceRub: 1, originalAmount: 2799, currency: 'USD' },
      { name: 'Essential', period: 'year', priceRub: 1, originalAmount: 7999, currency: 'USD' },
    ],
  },
};

const customService: ServiceLike = {
  id: 'svc-2',
  slug: 'airbnb',
  name: 'Airbnb',
  isActive: true,
  pricingPolicy: {
    tiers: [{ name: 'Booking', period: 'month', priceRub: 1, originalAmount: 1, currency: 'USD' }],
  },
};

const okResult = {
  orderId: 'o1',
  shortId: '12345',
  amountRubKopecks: 191_000,
  commissionKopecks: 19_100,
  totalRubKopecks: 210_100,
  rateUsdRubKopecks: 955_000,
  expiresAt: '2026-06-15T12:00:00.000Z',
  isCustom: false,
};

const base = { userId: 'u1', conversationId: 'c1', channel: 'telegram' as const };

beforeEach(() => {
  h.service = null;
  h.proposeImpl.mockReset();
  h.appendMock.mockReset();
  h.appendMock.mockResolvedValue({ id: 'm1' });
});

describe('proposeFromCatalog', () => {
  it('тарифный сервис: цена из каталога, лейбл с периодом', async () => {
    h.service = tierService;
    h.proposeImpl.mockResolvedValue(okResult);

    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.card.service).toBe('Claude Pro (Pro · месяц)');
    expect(res.card.totalKopecks).toBe(210_100);
    expect(res.card.orderId).toBe('o1');
    // Цена строго серверная: amountUsdCents берётся из tier.originalAmount, не от клиента.
    expect(h.proposeImpl).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'svc-1', amountUsdCents: 2000, userId: 'u1' }),
    );
  });

  it('тарифный сервис: неизвестный тариф → tier_not_found', async () => {
    h.service = tierService;
    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'NoSuch' });
    expect(res).toMatchObject({ ok: false, error: 'tier_not_found' });
    expect(h.proposeImpl).not.toHaveBeenCalled();
  });

  it('тарифный сервис: выбирает тариф по имени и периоду', async () => {
    h.service = multiPeriodService;
    h.proposeImpl.mockResolvedValue(okResult);

    const res = await proposeFromCatalog({
      ...base,
      slug: 'playstation-plus',
      tierName: 'Essential',
      tierPeriod: 'quarter',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.card.service).toBe('PlayStation Plus (Essential · 3 месяца)');
    expect(h.proposeImpl).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'svc-3', amountUsdCents: 2799 }),
    );
  });

  it('custom-amount: с суммой → ok (лейбл без тарифа)', async () => {
    h.service = customService;
    h.proposeImpl.mockResolvedValue(okResult);

    const res = await proposeFromCatalog({ ...base, slug: 'airbnb', amountUsdCents: 12_000 });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.card.service).toBe('Airbnb');
    expect(h.proposeImpl).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'svc-2', amountUsdCents: 12_000 }),
    );
  });

  it('custom-amount: без суммы → amount_required', async () => {
    h.service = customService;
    const res = await proposeFromCatalog({ ...base, slug: 'airbnb' });
    expect(res).toMatchObject({ ok: false, error: 'amount_required' });
    expect(h.proposeImpl).not.toHaveBeenCalled();
  });

  it('сервис не найден / неактивен → service_not_found', async () => {
    h.service = null;
    const res = await proposeFromCatalog({ ...base, slug: 'ghost', tierName: 'Pro' });
    expect(res).toMatchObject({ ok: false, error: 'service_not_found' });

    h.service = { ...tierService, isActive: false };
    const res2 = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });
    expect(res2).toMatchObject({ ok: false, error: 'service_not_found' });
  });

  it('proposeOrder бросает OrderCapExceededError → order_cap_exceeded', async () => {
    h.service = tierService;
    h.proposeImpl.mockRejectedValue(new OrderCapExceededError('cap'));
    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });
    expect(res).toMatchObject({ ok: false, error: 'order_cap_exceeded' });
    if (res.ok) throw new Error('expected fail');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('proposeOrder бросает OrderAmountOutOfBoundsError → amount_out_of_bounds', async () => {
    h.service = tierService;
    h.proposeImpl.mockRejectedValue(new OrderAmountOutOfBoundsError('bounds'));
    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });
    expect(res).toMatchObject({ ok: false, error: 'amount_out_of_bounds' });
  });

  it('proposeOrder бросает OrderBelowMinimumError → below_min', async () => {
    h.service = tierService;
    h.proposeImpl.mockRejectedValue(new OrderBelowMinimumError('min'));
    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });
    expect(res).toMatchObject({ ok: false, error: 'below_min' });
    if (res.ok) throw new Error('expected fail');
    expect(res.text).toContain('500');
  });

  it('неожиданная ошибка → propose_failed', async () => {
    h.service = tierService;
    h.proposeImpl.mockRejectedValue(new Error('db down'));
    const res = await proposeFromCatalog({ ...base, slug: 'claude-pro', tierName: 'Pro' });
    expect(res).toMatchObject({ ok: false, error: 'propose_failed' });
  });
});
