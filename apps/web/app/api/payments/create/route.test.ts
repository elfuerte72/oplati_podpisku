import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

type OrderLike = {
  id: string;
  userId: string;
  shortId: string;
  status: string;
  amountRub: number;
  expiresAt: Date | null;
};

type PendingPaymentLike = { id: string; rawPayload: Record<string, unknown> | null };

const h = vi.hoisted(() => ({
  // Сентинел транзакции: ассертим, что репо-функции получают именно его,
  // а не внешний db — это и есть гарантия «в одной транзакции» (M-2).
  txSentinel: { __tag: 'tx' } as object,
  transactionMock: vi.fn(),
  upsertMock: vi.fn(),
  transitionMock: vi.fn(async () => ({})),
  setExpiresMock: vi.fn(async () => {}),
  state: {
    order: null as OrderLike | null,
    pendingPayment: null as PendingPaymentLike | null,
    // null → настоящий потолок шлюза (у L&P его нет). Число подменяет его для
    // проверки гейта, не заставляя весь файл переключаться на Freekassa: там
    // потребовались бы ещё и её ключи в env.
    maxAmountRubOverride: null as number | null,
    payerContact: null as {
      telegramId: string | null;
      email: string | null;
      phone?: string | null;
    } | null,
    phoneThreshold: null as number | null,
  },
  phoneGateNotifyMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({ transaction: h.transactionMock }),
  getOrderById: vi.fn(async () => h.state.order),
  getUserPayerContact: vi.fn(async () => h.state.payerContact),
  upsertPaymentByProviderRef: h.upsertMock,
  transitionOrder: h.transitionMock,
  setOrderExpiresAt: h.setExpiresMock,
  findPendingPaymentByOrderId: vi.fn(async () => h.state.pendingPayment),
}));

vi.mock('@/lib/loveandpay', () => {
  class LoveAndPayApiError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(opts: { code: string; httpStatus: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.httpStatus = opts.httpStatus;
    }
  }
  return {
    LoveAndPayApiError,
    getLoveAndPayClient: () => ({
      createInvoice: vi.fn(async () => ({
        invoice: {
          id: 'inv-1',
          invoiceNumber: 'INV-0001',
          paymentLink: 'https://pay.example/inv-1',
          qrPayload: null,
          expiresAt: '2026-07-19T00:00:00.000Z',
        },
      })),
    }),
  };
});

// Healthcheck прокси тянет notify-ops → grammY — в юнитах не нужен.
vi.mock('@/lib/jobs/proxy-health', () => ({
  alertOnLoveAndPayProxyDown: vi.fn(async () => {}),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@/lib/contacts/phone-gate', () => ({
  phoneRequirementRub: () => h.state.phoneThreshold,
  notifyPhoneGateBlocked: h.phoneGateNotifyMock,
}));

vi.mock('@/lib/payments/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/payments/gateway')>();
  return {
    ...actual,
    maxAmountRubFor: (gateway: 'loveandpay' | 'freekassa') =>
      h.state.maxAmountRubOverride ?? actual.maxAmountRubFor(gateway),
  };
});

import { POST } from './route.ts';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/payments/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': 'test-internal-token',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.pendingPayment = null;
  h.state.maxAmountRubOverride = null;
  h.state.order = {
    id: ORDER_ID,
    userId: '22222222-2222-4222-8222-222222222222',
    shortId: 'AB12',
    status: 'ready_for_payment',
    amountRub: 100_000, // 1000 ₽ — выше минимума терминала 500 ₽
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  // Дефолт — профиль с почтой: гейт email_required проверяется отдельным сьютом.
  h.state.payerContact = { telegramId: '12345', email: 'client@example.com' };
  h.state.phoneThreshold = null;
  // Транзакция исполняет callback с сентинелом (rollback-семантику проверяет
  // интеграционный сьют packages/db на реальном Postgres).
  h.transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(h.txSentinel),
  );
  h.upsertMock.mockImplementation(async () => ({
    isNew: true,
    payment: { id: 'pay-1' },
  }));
});

describe('POST /api/payments/create — атомарность записи платежа и перехода (M-2)', () => {
  it('upsert платежа, переход заказа и выравнивание срока идут В ОДНОЙ транзакции', async () => {
    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; paymentUrl: string; expiresAt: string };

    expect(resp.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.paymentUrl).toBe('https://pay.example/inv-1');
    expect(json.expiresAt).toBe('2026-07-19T00:00:00.000Z');

    // Сбой БД между INSERT платежа и переходом раньше оставлял живой L&P-инвойс
    // при заказе в ready_for_payment (аудит M-2) — теперь все три операции
    // обязаны получить ОДИН транзакционный хендл.
    expect(h.transactionMock).toHaveBeenCalledTimes(1);
    expect(h.upsertMock).toHaveBeenCalledWith(h.txSentinel, expect.anything());
    expect(h.transitionMock).toHaveBeenCalledWith(
      h.txSentinel,
      expect.objectContaining({ orderId: ORDER_ID, toStatus: 'pending_payment' }),
    );
    expect(h.setExpiresMock).toHaveBeenCalledWith(
      h.txSentinel,
      ORDER_ID,
      new Date('2026-07-19T00:00:00.000Z'),
    );
  });

  it('дубль (isNew=false) — переход и выравнивание срока не выполняются', async () => {
    h.upsertMock.mockImplementation(async () => ({ isNew: false, payment: { id: 'pay-1' } }));

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
    expect(h.transitionMock).not.toHaveBeenCalled();
    expect(h.setExpiresMock).not.toHaveBeenCalled();
  });

  it('протухшая фиксация цены → 409 order_expired, счёт в L&P не создаётся', async () => {
    h.state.order = { ...h.state.order!, expiresAt: new Date(Date.now() - 1000) };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { error: string };

    expect(resp.status).toBe(409);
    expect(json.error).toBe('order_expired');
    expect(h.upsertMock).not.toHaveBeenCalled();
    // Захоронение протухшего черновика — вне платёжной транзакции (её ещё нет).
    expect(h.transitionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'expired', eventType: 'order_expired' }),
    );
  });
});

const STORED_INVOICE = {
  invoice: {
    id: 'inv-winner',
    invoiceNumber: 'INV-0002',
    paymentLink: 'https://pay.example/inv-winner',
    qrPayload: 'sbp://winner',
    expiresAt: '2026-07-19T01:00:00.000Z',
  },
};

describe('POST /api/payments/create — идемпотентность повторного confirm (T-1)', () => {
  it('repeat_confirm: заказ уже в pending_payment → 200 с существующим инвойсом из rawPayload', async () => {
    h.state.order = {
      id: ORDER_ID,
      userId: '22222222-2222-4222-8222-222222222222',
      shortId: 'AB12',
      status: 'pending_payment',
      amountRub: 100_000,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    h.state.pendingPayment = { id: 'pay-winner', rawPayload: STORED_INVOICE };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; paymentUrl: string };

    expect(resp.status).toBe(200);
    expect(json.ok).toBe(true);
    // storedInvoiceSchema распарсил rawPayload победителя.
    expect(json.paymentUrl).toBe('https://pay.example/inv-winner');
    // Новый инвойс НЕ создавался.
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  it('repeat_confirm по счёту Freekassa: общий конверт rawPayload читается тем же кодом', async () => {
    // Конверт `{ invoice: {...} }` у обоих шлюзов одинаковый (lib/payments/gateway.ts),
    // поэтому повторный confirm отдаёт ссылку, не зная, кто выставил счёт. Если
    // конверт Freekassa разъедется — клиент после переключения провайдера
    // получил бы 409 «оформи заново» вместо рабочей ссылки.
    h.state.order = {
      id: ORDER_ID,
      userId: '22222222-2222-4222-8222-222222222222',
      shortId: 'AB12',
      status: 'pending_payment',
      amountRub: 100_000,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    h.state.pendingPayment = {
      id: 'pay-fk',
      rawPayload: {
        invoice: {
          id: '123',
          invoiceNumber: 'AB12-a1b2c3',
          paymentLink: 'https://pay.freekassa.ru/form/123/hash',
          qrPayload: null,
          expiresAt: '2026-07-26T12:00:00.000Z',
        },
        provider: 'freekassa',
        orderHash: 'hash',
      },
    };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; paymentUrl: string };

    expect(resp.status).toBe(200);
    expect(json.paymentUrl).toBe('https://pay.freekassa.ru/form/123/hash');
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  it('repeat_confirm без живого инвойса (или с битым rawPayload) → 409 invalid_status', async () => {
    h.state.order = {
      id: ORDER_ID,
      userId: '22222222-2222-4222-8222-222222222222',
      shortId: 'AB12',
      status: 'pending_payment',
      amountRub: 100_000,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    h.state.pendingPayment = { id: 'pay-broken', rawPayload: { garbage: true } };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { error: string };

    expect(resp.status).toBe(409);
    expect(json.error).toBe('invalid_status');
  });

  it('гонка 23505 (unique pending на заказ) → проигравший получает инвойс победителя', async () => {
    // INSERT платежа проигравшего ловит 23505 по payments_one_pending_per_order_idx —
    // транзакция откатывается, роут отвечает существующим pending-инвойсом.
    h.upsertMock.mockImplementation(async () => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint_name: 'payments_one_pending_per_order_idx',
      });
    });
    h.state.pendingPayment = { id: 'pay-winner', rawPayload: STORED_INVOICE };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; paymentUrl: string };

    expect(resp.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.paymentUrl).toBe('https://pay.example/inv-winner');
  });
});

describe('POST /api/payments/create — гейт email плательщика (антифрод-трек, Р2)', () => {
  it('без email в профиле → 422 email_required, счёт у провайдера НЕ создаётся', async () => {
    // Защита от обхода UI: плашка контактов не даст отправить пустое поле, но
    // self-call из бота и прямые вызовы должны получить осмысленную ошибку.
    h.state.payerContact = { telegramId: '12345', email: null };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { error: string };

    expect(resp.status).toBe(422);
    expect(json.error).toBe('email_required');
    expect(h.transactionMock).not.toHaveBeenCalled();
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  it('профиль вовсе без строки users → тот же 422 email_required', async () => {
    h.state.payerContact = null;

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(422);
    expect(((await resp.json()) as { error: string }).error).toBe('email_required');
  });

  it('repeat_confirm по уже выставленному счёту email не требует', async () => {
    // Счёт выставлен до фичи → клиент со старой ссылкой должен доплатить
    // спокойно; гейт распространяется только на НОВЫЕ счета.
    h.state.payerContact = { telegramId: '12345', email: null };
    h.state.order = { ...h.state.order!, status: 'pending_payment' };
    h.state.pendingPayment = { id: 'pay-1', rawPayload: STORED_INVOICE };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('POST /api/payments/create — гейт телефона от порога (антифрод-трек, тикет 05)', () => {
  it('порог не задан → телефон не спрашивается нигде (фича выключена)', async () => {
    // Дефолт env — undefined: безопасный rollout.
    h.state.phoneThreshold = null;
    h.state.payerContact = { telegramId: '12345', email: 'client@example.com', phone: null };
    h.state.order = { ...h.state.order!, amountRub: 5_000_000 }; // 50 000 ₽

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
  });

  it('сумма ≥ порога без номера → 422 phone_required с порогом в теле + DM оператору', async () => {
    h.state.phoneThreshold = 10_000;
    h.state.payerContact = { telegramId: '12345', email: 'client@example.com', phone: null };
    h.state.order = { ...h.state.order!, amountRub: 1_000_000 }; // 10 000 ₽ ровно

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { error: string; requiredFromRub: number };

    expect(resp.status).toBe(422);
    expect(json.error).toBe('phone_required');
    // Порог в теле ответа — UI показывает динамически (не зашивать в тексты).
    expect(json.requiredFromRub).toBe(10_000);
    expect(h.transactionMock).not.toHaveBeenCalled();
    // DM оператору (дедуп проверяет unit-сьют phone-gate).
    expect(h.phoneGateNotifyMock).toHaveBeenCalledTimes(1);
  });

  it('сумма ниже порога или номер в профиле → счёт выставляется', async () => {
    h.state.phoneThreshold = 10_000;

    h.state.payerContact = { telegramId: '12345', email: 'client@example.com', phone: null };
    h.state.order = { ...h.state.order!, amountRub: 999_900 }; // 9 999 ₽
    expect((await POST(makeRequest({ orderId: ORDER_ID }))).status).toBe(200);

    h.state.payerContact = {
      telegramId: '12345',
      email: 'client@example.com',
      phone: '+79991234567',
    };
    h.state.order = { ...h.state.order!, amountRub: 5_000_000 };
    expect((await POST(makeRequest({ orderId: ORDER_ID }))).status).toBe(200);
  });
});

describe('POST /api/payments/create — потолок суммы шлюза (лимит операции Freekassa)', () => {
  it('сумма выше потолка → 422 above_max_amount, счёт у провайдера НЕ создаётся', async () => {
    // Лимит операции Freekassa — 150 000 ₽; при потолке 140 000 ₽ заказ на
    // 150 000 ₽ обязан отбиться У НАС, иначе клиент получит непрозрачный текст
    // ошибки провайдера уже после нажатия «Оплатить».
    h.state.maxAmountRubOverride = 140_000;
    h.state.order = { ...h.state.order!, amountRub: 15_000_000 };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));
    const json = (await resp.json()) as { ok: boolean; error: string; maxAmountRub: number };

    expect(resp.status).toBe(422);
    expect(json.error).toBe('above_max_amount');
    expect(json.maxAmountRub).toBe(140_000);
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  it('ровно потолок → счёт выставляется (граница включительно)', async () => {
    h.state.maxAmountRubOverride = 140_000;
    h.state.order = { ...h.state.order!, amountRub: 14_000_000 };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
    expect(h.upsertMock).toHaveBeenCalledTimes(1);
  });

  it('у шлюза без потолка (L&P, 0) крупная сумма проходит', async () => {
    // Регресс на «случайно применили лимит Freekassa к обоим шлюзам»: у L&P
    // потолок не объявлен, и придумывать его нельзя.
    h.state.order = { ...h.state.order!, amountRub: 50_000_000 };

    const resp = await POST(makeRequest({ orderId: ORDER_ID }));

    expect(resp.status).toBe(200);
    expect(h.upsertMock).toHaveBeenCalledTimes(1);
  });
});
