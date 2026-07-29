import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const listActiveServices = vi.fn();
const resolveUsdtRubRate = vi.fn();

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as never,
  listActiveServices: (...args: unknown[]) => listActiveServices(...args),
}));
vi.mock('@/lib/rapira/rates', () => ({
  resolveUsdtRubRate: (...args: unknown[]) => resolveUsdtRubRate(...args),
}));

const { loadCatalog, resetCatalogCacheForTests } = await import('./load.ts');

/** Минимальная активная строка каталога с одним USD-тарифом (форма — как в build.test.ts). */
function serviceRow(slug: string) {
  return {
    slug,
    name: slug,
    category: 'ai',
    requiresKyc: false,
    pricingPolicy: {
      tiers: [
        { name: 'Pro', period: 'month', priceRub: 253000, originalAmount: 2000, currency: 'USD' },
      ],
      margin: 0.15,
    },
  };
}

beforeEach(() => {
  resetCatalogCacheForTests();
  listActiveServices.mockReset();
  resolveUsdtRubRate.mockReset();
  resolveUsdtRubRate.mockResolvedValue(80);
});

describe('loadCatalog', () => {
  it('кэширует: второй вызов не ходит в источники', async () => {
    listActiveServices.mockResolvedValue([serviceRow('claude')]);
    await loadCatalog();
    await loadCatalog();
    expect(listActiveServices).toHaveBeenCalledTimes(1);
    expect(resolveUsdtRubRate).toHaveBeenCalledTimes(1);
  });

  it('single-flight: залп одновременных запросов даёт ОДНО обращение к источникам', async () => {
    // Ровно сценарий всплеска: кэш пуст, десять посетителей разом. Без
    // single-flight это десять запросов в БД и десять — в Rapira.
    let release: (v: unknown[]) => void = () => {};
    listActiveServices.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const calls = Array.from({ length: 10 }, () => loadCatalog());
    release([serviceRow('claude')]);
    const results = await Promise.all(calls);

    expect(listActiveServices).toHaveBeenCalledTimes(1);
    expect(resolveUsdtRubRate).toHaveBeenCalledTimes(1);
    // Все получили одну и ту же витрину.
    for (const r of results) expect(r).toHaveLength(1);
  });

  it('источник упал после удачной загрузки — отдаём последнюю витрину, а не ошибку', async () => {
    listActiveServices.mockResolvedValueOnce([serviceRow('claude')]);
    const first = await loadCatalog();
    expect(first).toHaveLength(1);

    resetTtl();
    listActiveServices.mockRejectedValue(new Error('db down'));
    await expect(loadCatalog()).resolves.toHaveLength(1);
  });

  it('после отказа не долбит источник каждым запросом', async () => {
    listActiveServices.mockResolvedValueOnce([serviceRow('claude')]);
    await loadCatalog();

    resetTtl();
    listActiveServices.mockRejectedValue(new Error('db down'));
    await loadCatalog();
    const afterFirstFailure = listActiveServices.mock.calls.length;
    await loadCatalog();
    await loadCatalog();
    expect(listActiveServices.mock.calls.length).toBe(afterFirstFailure);
  });

  it('витрины нет вовсе и источник лежит — бросаем, деградацию решает caller', async () => {
    listActiveServices.mockRejectedValue(new Error('db down'));
    await expect(loadCatalog()).rejects.toThrow('db down');
  });
});

/**
 * Протухание TTL без ожидания пяти минут: сдвигаем часы вперёд. `Date.now`
 * возвращается в исходное состояние автоматически (`vi.useRealTimers` не нужен —
 * подменяем только спай на конкретный вызов).
 */
function resetTtl(): void {
  const realNow = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000);
}
