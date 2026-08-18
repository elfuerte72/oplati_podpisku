import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Добор потерянных уведомлений — единственная страховка от зависшего платежа
 * (деньги списаны, заказ висит «ждёт оплаты»). До этапа 4 ТЗ цикл был захардкожен
 * на L&P (`if (payment.provider !== 'loveandpay') continue`), и платежи Freekassa
 * молча оставались без неё. Тест держит именно этот регресс.
 */

type Pay = {
  id: string;
  orderId?: string;
  provider: string;
  providerRef: string;
  providerInvoiceNumber: string | null;
  lastProviderStatus?: number | null;
};

const h = vi.hoisted(() => ({
  pending: [] as Pay[],
  freekassaConfigured: true,
  loveAndPayConfigured: { value: true },
  paySpaceConfigured: false,
  getInvoiceMock: vi.fn(),
  findOrderMock: vi.fn(),
  // (...args: unknown[]) — чтобы `mock.calls[0][0]` был доступен в ассертах:
  // у vi.fn() без параметров тип аргументов пустой кортеж.
  lnpPaidMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  lnpTerminalMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  fkPaidMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  fkTerminalMock: vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'processed' })),
  setProviderStatusMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  transitionOrderMock: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  botSendMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  appendEventMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  notifyStaffMock: vi.fn((..._args: unknown[]) =>
    Promise.resolve({ delivered: 1, failed: 0, deduped: false }),
  ),
  stuckPaidMock: vi.fn((..._args: unknown[]) => Promise.resolve<unknown[]>([])),
  getOrderByIdMock: vi.fn((..._args: unknown[]) =>
    Promise.resolve<unknown>({ id: 'order-1', userId: 'user-1', status: 'payment_review' }),
  ),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findPendingPaymentsForPoll: vi.fn(async () => h.pending),
  findStuckPaidOrders: h.stuckPaidMock,
  findStuckInFulfillmentOrders: vi.fn(async () => []),
  setPaymentProviderStatus: h.setProviderStatusMock,
  transitionOrder: h.transitionOrderMock,
  getOrderById: h.getOrderByIdMock,
  getUserTelegramId: vi.fn(async () => '555'),
  appendOrderEvent: h.appendEventMock,
  PAYMENT_REVIEW_CLIENT_NOTIFIED_EVENT: 'payment_review_client_notified',
}));

vi.mock('../telegram/bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.botSendMock } }),
}));

vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => h.paySpaceConfigured,
}));

vi.mock('../freekassa/index.ts', () => ({
  isFreekassaConfigured: () => h.freekassaConfigured,
  getFreekassaClient: () => ({ findOrderByPaymentId: h.findOrderMock }),
}));

vi.mock('../freekassa/handlers.ts', () => ({
  processFreekassaPaid: h.fkPaidMock,
  processFreekassaTerminal: h.fkTerminalMock,
}));

vi.mock('../loveandpay/index.ts', () => ({
  getLoveAndPayClient: () => ({ getInvoice: h.getInvoiceMock }),
  isLoveAndPayConfigured: () => h.loveAndPayConfigured.value,
}));

vi.mock('../loveandpay/handlers.ts', () => ({
  processInvoicePaid: h.lnpPaidMock,
  processInvoiceTerminal: h.lnpTerminalMock,
  loveAndPayTerminalReason: (s: string) =>
    s === 'EXPIRED' ? 'expired' : s === 'CANCELLED' ? 'cancelled' : null,
}));

vi.mock('./proxy-health.ts', () => ({ alertOnLoveAndPayProxyDown: vi.fn(async () => {}) }));
vi.mock('./payment-conversion.ts', () => ({ alertOnZeroPaymentConversion: vi.fn(async () => {}) }));
vi.mock('./payment-review-watch.ts', () => ({ alertOnStalePaymentReview: vi.fn(async () => {}) }));
vi.mock('./vcc-balance.ts', () => ({ alertOnLowVccBalance: vi.fn(async () => {}) }));
vi.mock('./issue-card.ts', () => ({ issueCard: vi.fn(async () => {}) }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: vi.fn(async () => {}) }));

vi.mock('../alerts/notify-staff.ts', () => ({ notifyStaff: h.notifyStaffMock }));

import { captureException } from '@sentry/nextjs';

import { pollPayments } from './poll-payment.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { resetUnknownStatusAlertDedupForTests } from './poll-payment-one.ts';

const FK_PAYMENT: Pay = {
  id: 'pay-fk',
  orderId: 'order-1',
  provider: 'freekassa',
  providerRef: '123',
  providerInvoiceNumber: 'ORD-S3MGS-a1b2c3',
  lastProviderStatus: null,
};

const LNP_PAYMENT: Pay = {
  id: 'pay-lnp',
  provider: 'loveandpay',
  providerRef: 'inv-1',
  providerInvoiceNumber: 'INV-0001',
};

function fkOrder(status: number, over: Record<string, unknown> = {}) {
  return {
    merchant_order_id: 'ORD-S3MGS-a1b2c3',
    fk_order_id: '123',
    amount: '2490.50',
    status,
    ...over,
  };
}

describe('pollPayments — добор по провайдерам', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUnknownStatusAlertDedupForTests();
    h.pending = [];
    h.freekassaConfigured = true;
    h.loveAndPayConfigured.value = true;
    h.paySpaceConfigured = false;
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PENDING',
    });
    h.findOrderMock.mockResolvedValue(null);
    // `clearAllMocks` снимает и реализацию: возвращаем дефолт, иначе заказ
    // приходит `undefined` и ветки холда молча не выполняются.
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      status: 'payment_review',
    });
    h.stuckPaidMock.mockResolvedValue([]);
    h.notifyStaffMock.mockResolvedValue({ delivered: 1, failed: 0, deduped: false });
  });

  it('оплаченный счёт Freekassa восстанавливается (уведомление потеряно)', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(1));

    const res = await pollPayments();

    expect(h.fkPaidMock).toHaveBeenCalledTimes(1);
    expect(h.fkPaidMock.mock.calls[0]?.[0]).toMatchObject({
      intid: '123',
      merchantOrderId: 'ORD-S3MGS-a1b2c3',
      amountRaw: '2490.50',
      recoveredViaPolling: true,
    });
    expect(res.recovered).toBe(1);
  });

  it('ищет заказ по НАШЕМУ paymentId, а не по providerRef провайдера', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(1));

    await pollPayments();

    expect(h.findOrderMock).toHaveBeenCalledWith('ORD-S3MGS-a1b2c3');
  });

  it('отменённый и ошибочный счёт хоронятся терминально', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(9));
    await pollPayments();
    expect(h.fkTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'cancelled' });

    vi.clearAllMocks();
    h.findOrderMock.mockResolvedValue(fkOrder(8));
    await pollPayments();
    expect(h.fkTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'failed' });
  });

  it('новый (ещё не оплаченный) счёт не трогаем', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(0));

    const res = await pollPayments();

    expect(h.fkPaidMock).not.toHaveBeenCalled();
    expect(h.fkTerminalMock).not.toHaveBeenCalled();
    expect(res.recovered).toBe(0);
  });

  it('заказа у провайдера нет — не хороним (это сделает expire-payments по сроку)', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(null);

    await pollPayments();

    expect(h.fkPaidMock).not.toHaveBeenCalled();
    expect(h.fkTerminalMock).not.toHaveBeenCalled();
  });

  it('без ключей Freekassa (dev-стенд) платёж пропускается без ошибки', async () => {
    h.pending = [FK_PAYMENT];
    h.freekassaConfigured = false;

    const res = await pollPayments();

    expect(h.findOrderMock).not.toHaveBeenCalled();
    expect(res.errors).toBe(0);
  });

  it('платёж без нашего paymentId пропускается, а не роняет прогон', async () => {
    h.pending = [{ ...FK_PAYMENT, providerInvoiceNumber: null }];

    const res = await pollPayments();

    expect(h.findOrderMock).not.toHaveBeenCalled();
    expect(res.errors).toBe(0);
  });

  it('сбой опроса одного провайдера не мешает добрать платёж другого', async () => {
    // Раньше исключение на любом платеже ловилось внутри цикла — сохраняем это
    // свойство: один лежащий шлюз не должен лишать страховки второй.
    h.pending = [FK_PAYMENT, LNP_PAYMENT];
    h.findOrderMock.mockRejectedValue(new Error('freekassa down'));
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PAID',
    });

    const res = await pollPayments();

    expect(res.errors).toBe(1);
    expect(h.lnpPaidMock).toHaveBeenCalledTimes(1);
    expect(res.recovered).toBe(1);
  });

  it('L&P-путь не изменился: PAID восстанавливается, EXPIRED хоронится', async () => {
    h.pending = [LNP_PAYMENT];
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'PAID',
    });
    expect((await pollPayments()).recovered).toBe(1);

    vi.clearAllMocks();
    h.getInvoiceMock.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-0001',
      amount: 100,
      currency: 'RUB',
      status: 'EXPIRED',
    });
    await pollPayments();
    expect(h.lnpTerminalMock.mock.calls[0]?.[0]).toMatchObject({ reason: 'expired' });
  });

  it('РЕГРЕСС: ключей L&P нет — «опрашивать нечем», а не ошибка на каждый платёж', async () => {
    // Гейт симметричен isFreekassaConfigured. Без него getLoveAndPayClient()
    // бросал, и для expire-payments это означало «статус неизвестен» → заказ
    // не хоронится никогда (находка ревью).
    h.pending = [LNP_PAYMENT];
    h.loveAndPayConfigured.value = false;

    const res = await pollPayments();

    expect(res.errors).toBe(0);
    expect(res.recovered).toBe(0);
    expect(h.getInvoiceMock).not.toHaveBeenCalled();
  });

  it('провайдеры без добора (manual) просто пропускаются', async () => {
    h.pending = [{ id: 'pay-m', provider: 'manual', providerRef: 'x', providerInvoiceNumber: null }];

    const res = await pollPayments();

    expect(res.errors).toBe(0);
    expect(h.getInvoiceMock).not.toHaveBeenCalled();
    expect(h.findOrderMock).not.toHaveBeenCalled();
  });
  it('порядок nonce делегирован клиенту — крон гонит все платежи одним пулом', async () => {
    // Раньше freekassa-платежи отделялись и гнались с concurrency=1: очередь
    // жила здесь. Теперь очередь внутри FreekassaClient (`serialized`), потому
    // что потребителей API стало двое. Здесь остаётся проверить, что ни один
    // платёж не потерян, а порядок nonce покрыт тестом клиента.
    h.pending = Array.from({ length: 8 }, (_, i) => ({
      id: `pay-${i}`,
      provider: 'freekassa' as const,
      providerRef: String(i),
      providerInvoiceNumber: `ORD-${i}`,
    }));
    h.findOrderMock.mockResolvedValue(null);

    const res = await pollPayments();

    expect(h.findOrderMock).toHaveBeenCalledTimes(8);
    expect(res.processed).toBe(8);
    expect(res.errors).toBe(0);
  });

  it('РЕГРЕСС: медленные freekassa-опросы не задерживают добор Love&Pay', async () => {
    // Две последовательные очереди означали, что бэклог одного шлюза съедает
    // шаг крона другого — ровно тот отказ, ради которого пул и появился.
    h.pending = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `pay-fk-${i}`,
        provider: 'freekassa' as const,
        providerRef: String(i),
        providerInvoiceNumber: `ORD-${i}`,
      })),
      {
        id: 'pay-lnp',
        provider: 'loveandpay' as const,
        providerRef: 'inv-1',
        providerInvoiceNumber: null,
      },
    ];
    let lnpStartedAt = Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    h.findOrderMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    });
    h.getInvoiceMock.mockImplementation(async () => {
      lnpStartedAt = Date.now();
      return { id: 'inv-1', invoiceNumber: 'INV-1', amount: 100, currency: 'RUB', status: 'NEW' };
    });

    await pollPayments();

    // L&P стартовал, не дожидаясь всей пачки freekassa (4 × 30 мс).
    expect(lnpStartedAt - startedAt).toBeLessThan(60);
  });

  it('Love&Pay опрашивается параллельно, но не более POLL_CONCURRENCY разом', async () => {
    // У L&P nonce нет, ограничивать порядок нечем — здесь параллелизм безопасен
    // и даёт весь выигрыш: последовательный цикл не влезал в шаг крона.
    h.pending = Array.from({ length: 12 }, (_, i) => ({
      id: `pay-lnp-${i}`,
      provider: 'loveandpay' as const,
      providerRef: `inv-${i}`,
      providerInvoiceNumber: `INV-${i}`,
    }));

    let inFlight = 0;
    let peak = 0;
    h.getInvoiceMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      return {
        id: 'inv-1',
        invoiceNumber: 'INV-0001',
        amount: 100,
        currency: 'RUB',
        status: 'PENDING',
      };
    });

    await pollPayments();

    expect(h.getInvoiceMock).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('падение одного платежа не уносит остальную пачку', async () => {
    h.pending = [FK_PAYMENT, { ...FK_PAYMENT, id: 'pay-fk-2', providerRef: '124' }];
    h.findOrderMock
      .mockRejectedValueOnce(new Error('провайдер отвалился'))
      .mockResolvedValueOnce(fkOrder(1));

    const res = await pollPayments();

    expect(res.errors).toBe(1);
    // Второй платёж всё равно обработан — воркер пула не умер вместе с первым.
    expect(h.findOrderMock).toHaveBeenCalledTimes(2);
  });

  it('неизвестный статус провайдера поднимает тревогу владельцу (инцидент 14.08)', async () => {
    // Инцидент 14.08: клиент оплатил, Freekassa вернула код вне документации.
    // Статус 7 с тех пор опознан как антифрод-холд (свой тест ниже) — ветку
    // неизвестных кодов держим живой на СЛЕДУЮЩИЙ сюрприз провайдера.
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(13));

    await pollPayments();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    const text = String(vi.mocked(notifyOps).mock.calls[0]?.[0]);
    expect(text).toContain('13');
    expect(text).toContain('123');
    // Карту не выдаём: статус не «оплачен».
    expect(h.fkPaidMock).not.toHaveBeenCalled();
  });

  it('антифрод-холд (7): DM говорит про холд, а не «неизвестный статус»', async () => {
    // Тикет 03: код 7 опознан (эмпирически, подтверждён поддержкой 2026-08-14).
    // Владелец должен видеть операционную ситуацию с известным следующим шагом,
    // а не тревогу о контрактном дрейфе.
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(7));

    await pollPayments();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    const text = String(vi.mocked(notifyOps).mock.calls[0]?.[0]);
    expect(text).toContain('нтифрод-холд');
    expect(text).not.toContain('нет в её документации');
    // Не терминален и не оплачен: заказ не трогаем.
    expect(h.fkPaidMock).not.toHaveBeenCalled();
    expect(h.fkTerminalMock).not.toHaveBeenCalled();
  });

  it('повторные прогоны холда не дублируют DM (прежний дедуп)', async () => {
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(7));

    await pollPayments();
    await pollPayments();

    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it('первый холд: заказ уходит «на проверку», клиент получает автосообщение', async () => {
    // Тикет 09: прежний снимок статуса не 7 → это ПЕРВОЕ обнаружение.
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: null }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));

    await pollPayments();

    expect(h.transitionOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'order-1',
        toStatus: 'payment_review',
        actorType: 'payment_provider',
      }),
    );
    expect(h.botSendMock).toHaveBeenCalledTimes(1);
    const text = String(h.botSendMock.mock.calls[0]?.[1]);
    expect(text).toContain('провер');
    expect(text).toContain('/support');
  });

  it('доставленное автосообщение записывается фактом в журнал заказа', async () => {
    // Экран холдов пишет «клиенту ушло». Выводить это из статусов нельзя:
    // отправка best-effort, и её сбой глушится log.warn — панель сказала бы
    // «ушло» там, где клиент молчит. Пишем факт, а не следствие.
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: null }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));

    await pollPayments();

    expect(h.appendEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'order-1',
        eventType: 'payment_review_client_notified',
      }),
    );
  });

  it('бот заблокирован клиентом — факта отправки НЕТ', async () => {
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: null }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));
    h.botSendMock.mockRejectedValueOnce(
      Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }),
    );

    await pollPayments();

    // Заказ всё равно «на проверке» — деньги важнее уведомления.
    expect(h.transitionOrderMock).toHaveBeenCalled();
    // А вот утверждать, что клиент предупреждён, нечем.
    expect(h.appendEventMock).not.toHaveBeenCalled();
  });

  it('повторный опрос того же холда клиента НЕ спамит (дедуп по прежнему статусу)', async () => {
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: 7 }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));

    await pollPayments();

    expect(h.transitionOrderMock).not.toHaveBeenCalled();
    expect(h.botSendMock).not.toHaveBeenCalled();
  });

  it('сорвавшийся перевод «на проверку» повторяется, а не хоронит заказ', async () => {
    // Снимок статуса 7 уже записан, но заказ остался `pending_payment` — значит,
    // прошлый переход упал транзиентно. Прежняя версия выходила по снимку, и
    // через час `expire-payments` уводил заказ в `expired`, а платёж в `failed`:
    // после этого его не опрашивает уже никто, а деньги клиента висят у
    // провайдера на проверке.
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: 7 }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      status: 'pending_payment',
    });

    await pollPayments();

    expect(h.transitionOrderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'payment_review' }),
    );
  });

  it('сбой записи факта не выдаётся за недоставленное сообщение', async () => {
    // Сообщение клиенту УШЛО, а запись отметки упала (икота БД). Общий catch
    // писал бы `hold_notify_failed` — при разборе инцидента это читается как
    // «клиент не предупреждён», хотя он предупреждён. Отметки не будет уже
    // никогда (следующий проход выйдет по дедупу), поэтому это единственный
    // шанс узнать причину — значит, Sentry.
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: null }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));
    h.appendEventMock.mockRejectedValueOnce(new Error('connection terminated'));

    await pollPayments();

    expect(h.botSendMock).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'hold_notify_fact' }) }),
    );
  });

  it('каждый опрос Freekassa сохраняет увиденный статус в платёж (тикет 03)', async () => {
    // Снимок кода в payments убирает слепоту «статус жил только в логе и DM» —
    // и служит дедупом автосообщения клиенту о холде (пачка 3).
    for (const status of [0, 7]) {
      vi.clearAllMocks();
      resetUnknownStatusAlertDedupForTests();
      h.pending = [FK_PAYMENT];
      h.findOrderMock.mockResolvedValue(fkOrder(status));

      await pollPayments();

      expect(h.setProviderStatusMock).toHaveBeenCalledWith(expect.anything(), {
        paymentId: 'pay-fk',
        providerStatus: status,
      });
    }
  });

  it('сбой записи снимка статуса не мешает добору оплаты', async () => {
    h.pending = [FK_PAYMENT];
    h.setProviderStatusMock.mockRejectedValueOnce(new Error('db hiccup'));
    h.findOrderMock.mockResolvedValue(fkOrder(1));

    const res = await pollPayments();

    expect(res.recovered).toBe(1);
    expect(h.fkPaidMock).toHaveBeenCalledTimes(1);
  });

  it('брошенный счёт (статус «Новый») владельца не беспокоит', async () => {
    // Больше половины счетов клиенты просто не оплачивают. Алерт на каждый
    // такой превратил бы денежный сигнал в фон.
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(0));

    await pollPayments();

    expect(notifyOps).not.toHaveBeenCalled();
  });

  it('документированные терминальные статусы тревогу не поднимают', async () => {
    for (const status of [8, 9, 6]) {
      vi.clearAllMocks();
      resetUnknownStatusAlertDedupForTests();
      h.pending = [FK_PAYMENT];
      h.findOrderMock.mockResolvedValue(fkOrder(status));

      await pollPayments();

      expect(notifyOps).not.toHaveBeenCalled();
    }
  });

  it('повторные прогоны по тому же платежу не дублируют DM', async () => {
    // Крон бежит каждые 5 минут, а зависший платёж живёт до вмешательства
    // человека — без дедупа владелец получал бы сообщение 12 раз в час.
    h.pending = [FK_PAYMENT];
    h.findOrderMock.mockResolvedValue(fkOrder(13));

    await pollPayments();
    await pollPayments();

    expect(notifyOps).toHaveBeenCalledTimes(1);
  });
});

describe('pollPayments — уведомления менеджеру (тикет 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUnknownStatusAlertDedupForTests();
    h.pending = [];
    h.freekassaConfigured = true;
    h.loveAndPayConfigured.value = true;
    h.paySpaceConfigured = true;
    h.findOrderMock.mockResolvedValue(null);
    h.stuckPaidMock.mockResolvedValue([]);
    h.notifyStaffMock.mockResolvedValue({ delivered: 1, failed: 0, deduped: false });
  });

  it('холд банка уходит менеджеру СРАЗУ, а не через семь дней', async () => {
    // Раньше про холд узнавали только через сторож `payment-review-watch` и
    // только владелец — на восьмой день.
    h.paySpaceConfigured = false;
    h.pending = [{ ...FK_PAYMENT, lastProviderStatus: null }];
    h.findOrderMock.mockResolvedValue(fkOrder(7));
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      status: 'payment_review',
    });

    await pollPayments();

    expect(h.notifyStaffMock).toHaveBeenCalledWith(
      expect.stringContaining('Холд банка'),
      expect.objectContaining({ capability: 'holds' }),
    );
  });

  it('застрявший заказ: пишем менеджеру, только когда ПОВТОР НЕ ПОМОГ', async () => {
    // Крон сам чинит зависшие в `paid` заказы. Уведомлять о каждом застревании
    // значило бы звать человека к уже починенному.
    h.stuckPaidMock.mockResolvedValue([{ id: 'order-9', shortId: 'ORD-STUCK' }]);
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-9',
      shortId: 'ORD-STUCK',
      userId: 'user-1',
      status: 'failed',
    });

    await pollPayments();

    expect(h.notifyStaffMock).toHaveBeenCalledWith(
      expect.stringContaining('ORD-STUCK'),
      expect.objectContaining({ capability: 'orders', dedupKey: 'stuck:order-9' }),
    );
  });

  it('повтор ПОМОГ — менеджера не беспокоим', async () => {
    h.stuckPaidMock.mockResolvedValue([{ id: 'order-9', shortId: 'ORD-STUCK' }]);
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-9',
      shortId: 'ORD-STUCK',
      userId: 'user-1',
      status: 'completed',
    });

    await pollPayments();

    expect(h.notifyStaffMock).not.toHaveBeenCalled();
  });

  it('заказ ещё в работе после повтора — тоже молчим', async () => {
    // `in_fulfillment` означает «выпуск идёт прямо сейчас»: звать человека рано.
    h.stuckPaidMock.mockResolvedValue([{ id: 'order-9', shortId: 'ORD-STUCK' }]);
    h.getOrderByIdMock.mockResolvedValue({
      id: 'order-9',
      shortId: 'ORD-STUCK',
      userId: 'user-1',
      status: 'in_fulfillment',
    });

    await pollPayments();

    expect(h.notifyStaffMock).not.toHaveBeenCalled();
  });
});
