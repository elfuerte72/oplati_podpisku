import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read-only tools помощника (тикет 05). Проверяем ЧТО возвращается модели:
 * клиентские слова, только свои заказы, маска карты, честный «инструкции нет».
 */

const h = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
  services: new Map<string, Record<string, unknown>>(),
  cards: new Map<string, Record<string, unknown>>(),
  catalog: [] as Record<string, unknown>[],
  requestHuman: vi.fn(async () => ({ acknowledged: true as const })),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getOrdersByUserId: vi.fn(async (_db: unknown, userId: string, limit: number) =>
    h.orders.filter((o) => o.userId === userId).slice(0, limit),
  ),
  getServicesByIds: vi.fn(async (_db: unknown, ids: string[]) =>
    ids.map((id) => h.services.get(id)).filter(Boolean),
  ),
  getServiceBySlug: vi.fn(async (_db: unknown, slug: string) =>
    [...h.services.values()].find((s) => s.slug === slug) ?? null,
  ),
  searchActiveServices: vi.fn(async (_db: unknown, query: string) =>
    h.catalog.filter((s) => String(s.name).toLowerCase().includes(query.toLowerCase())),
  ),
  // Выборка КАБИНЕТА: только свои живые карты. Здесь — все карты из стенда,
  // ограничение по владельцу проверяется в интеграционных тестах репозитория.
  findCardsByUserIdForCabinet: vi.fn(async () => [...h.cards.values()]),
}));

import { createSupportToolHandlers } from './tools';

const NOW = new Date('2026-08-27T12:00:00Z');

function order(over: Record<string, unknown>) {
  return {
    id: 'o-1',
    shortId: 'ORD-7KX42',
    userId: 'me',
    serviceId: 'svc-spotify',
    customServiceDescription: null,
    status: 'pending_payment',
    amountRub: 119000,
    expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    cardId: null,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    ...over,
  };
}

beforeEach(() => {
  h.orders = [];
  h.services.clear();
  h.cards.clear();
  h.catalog = [];
  vi.clearAllMocks();
  h.services.set('svc-spotify', {
    id: 'svc-spotify',
    slug: 'spotify',
    name: 'Spotify Premium',
    paymentInstructions: {
      requiresVpn: true,
      vpnLocation: 'США',
      requiredCurrency: 'USD',
      paymentNotes: 'Оплачивать только с включённым VPN.',
    },
  });
});

describe('get_my_orders', () => {
  it('отдаёт заказ клиентскими словами: номер, сервис, сумма, статус из словаря кабинета', async () => {
    h.orders = [order({})];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const res = await handlers.get_my_orders({});

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      number: 'ORD-7KX42',
      service: 'Spotify Premium',
      status: 'Ждёт оплаты',
    });
    // Сумма — тем же форматтером, что показывает клиенту кабинет: неразрывный
    // пробел между разрядами и перед знаком рубля ставит `Intl`, не мы.
    expect(res[0]?.amount?.replace(/\s/g, ' ')).toBe('1 190 ₽');
  });

  it('ни один внутренний идентификатор статуса в результат не попадает', async () => {
    h.orders = [
      order({ id: 'o-1', status: 'payment_review' }),
      order({ id: 'o-2', shortId: 'ORD-2', status: 'in_fulfillment' }),
      order({ id: 'o-3', shortId: 'ORD-3', status: 'ready_for_payment' }),
    ];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const json = JSON.stringify(await handlers.get_my_orders({}));

    for (const internal of ['payment_review', 'in_fulfillment', 'ready_for_payment', 'pending_payment']) {
      expect(json).not.toContain(internal);
    }
    expect(json).toContain('Платёж на проверке банка');
  });

  it('чужие заказы не видны — userId из контекста, не из ввода модели', async () => {
    h.orders = [order({ userId: 'someone-else' }), order({ id: 'o-mine', shortId: 'ORD-MINE' })];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const res = await handlers.get_my_orders({});
    expect(res.map((o) => o.number)).toEqual(['ORD-MINE']);
  });

  it('карта — только маска, никогда полный номер', async () => {
    h.cards.set('card-1', { id: 'card-1', panMasked: '**** 4417', status: 'active' });
    h.orders = [order({ status: 'completed', cardId: 'card-1' })];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const res = await handlers.get_my_orders({});
    expect(res[0]?.card).toBe('**** 4417');
  });

  it('срок называется словами для оплатимых заказов и не называется для завершённых', async () => {
    h.orders = [
      order({ id: 'o-1', status: 'pending_payment' }),
      order({ id: 'o-2', shortId: 'ORD-2', status: 'completed', expiresAt: new Date(NOW) }),
    ];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const res = await handlers.get_my_orders({});
    expect(res[0]?.validUntil).toMatch(/\d{1,2} \S+/);
    expect(res[1]?.validUntil).toBeNull();
  });

  it('заказ вне каталога называется описанием клиента', async () => {
    h.orders = [order({ serviceId: null, customServiceDescription: 'iCloud+ 200GB' })];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect((await handlers.get_my_orders({}))[0]?.service).toBe('iCloud+ 200GB');
  });

  it('не больше пяти, свежие первыми — модели незачем видеть историю за год', async () => {
    h.orders = Array.from({ length: 8 }, (_, i: number) => order({ id: `o-${i}`, shortId: `ORD-${i}` }));
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect(await handlers.get_my_orders({})).toHaveLength(5);
  });

  it('заказов нет — пустой список, а не ошибка', async () => {
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });
    expect(await handlers.get_my_orders({})).toEqual([]);
  });
});

describe('get_service_instructions', () => {
  it('находит сервис по названию и отдаёт инструкцию словами', async () => {
    h.catalog = [{ id: 'svc-spotify', slug: 'spotify', name: 'Spotify Premium', requiresKyc: false }];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    const res = await handlers.get_service_instructions({ query: 'spotify' });

    expect(res).toEqual({
      service: 'Spotify Premium',
      requiresVpn: true,
      vpnLocation: 'США',
      currency: 'USD',
      billing: null,
      notes: 'Оплачивать только с включённым VPN.',
    });
  });

  it('сервис есть, инструкции нет — честный «нет инструкции», а не пустой объект', async () => {
    h.services.set('svc-nf', { id: 'svc-nf', slug: 'netflix', name: 'Netflix', paymentInstructions: null });
    h.catalog = [{ id: 'svc-nf', slug: 'netflix', name: 'Netflix', requiresKyc: false }];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect(await handlers.get_service_instructions({ query: 'netflix' })).toEqual({
      notFound: true,
      query: 'netflix',
    });
  });

  it('сервиса нет в каталоге — notFound с исходным запросом', async () => {
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });
    expect(await handlers.get_service_instructions({ query: 'hulu' })).toEqual({
      notFound: true,
      query: 'hulu',
    });
  });

  it('ссылка на страницу оплаты в результат НЕ попадает — модели она не нужна, а клиенту её даст приложение', async () => {
    h.services.set('svc-spotify', {
      ...h.services.get('svc-spotify'),
      paymentInstructions: { requiresVpn: false, paymentUrl: 'https://spotify.com/premium' },
    });
    h.catalog = [{ id: 'svc-spotify', slug: 'spotify', name: 'Spotify Premium', requiresKyc: false }];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect(JSON.stringify(await handlers.get_service_instructions({ query: 'spotify' }))).not.toContain(
      'spotify.com',
    );
  });
});

describe('search_catalog', () => {
  it('подключён существующий обработчик', async () => {
    h.catalog = [{ id: 'svc-spotify', slug: 'spotify', name: 'Spotify Premium', requiresKyc: false }];
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect(await handlers.search_catalog({ query: 'spot' })).toEqual([
      { id: 'svc-spotify', slug: 'spotify', name: 'Spotify Premium', requiresKyc: false },
    ]);
  });
});

describe('request_human', () => {
  it('зовёт переданную эскалацию с причиной модели', async () => {
    const handlers = createSupportToolHandlers({ userId: 'me', requestHuman: h.requestHuman, now: NOW });

    expect(await handlers.request_human({ reason: 'вопрос про документы' })).toEqual({ acknowledged: true });
    expect(h.requestHuman).toHaveBeenCalledWith('вопрос про документы');
  });
});
