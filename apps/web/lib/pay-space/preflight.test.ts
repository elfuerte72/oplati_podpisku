import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Preflight карточного фонда (тикет 02 трека vcc-preflight).
 *
 * Инцидент 2026-08-14: клиент заплатил 11 680 ₽, а на карточном счёте лежало
 * $89.50 при нужных $124 — заказ упал уже ПОСЛЕ приёма денег. Проверка обязана
 * случиться ДО того, как клиент получит платёжную ссылку.
 */

const h = vi.hoisted(() => ({
  env: {
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
    PAYSPACE_API_KEY: 'test-key',
    PAYSPACE_PREFLIGHT_DISABLED: false,
  } as Record<string, unknown>,
  configured: true,
  balanceUsdCents: 100_000,
  activeCard: null as { id: string; createdAt: Date } | null,
  getVccBalance: vi.fn(),
  notifyStaff: vi.fn(async (..._args: unknown[]) => ({ delivered: 1, failed: 0, deduped: false })),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  appendOrderEvent: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({}, { get: (_t, prop: string) => h.env[prop] }),
}));

vi.mock('./index.ts', () => ({
  isPaySpaceConfigured: () => h.configured,
  getPaySpaceClient: () => ({ getVccBalance: h.getVccBalance }),
}));

vi.mock('../alerts/notify-staff.ts', () => ({ notifyStaff: h.notifyStaff }));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: h.captureMessage,
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findActiveByUserId: vi.fn(async () => h.activeCard),
  appendOrderEvent: h.appendOrderEvent,
  PAYMENT_BLOCKED_CAPACITY_EVENT: 'payment_blocked_capacity',
}));

import {
  checkOrderFundingCapacity,
  reportFundingCapacityBlocked,
  resetPreflightDedupForTests,
} from './preflight.ts';

const ORDER = {
  id: '11111111-1111-4111-8111-111111111111',
  shortId: 'AB12',
  userId: '22222222-2222-4222-8222-222222222222',
  originalAmount: 10_000, // $100
  amountRub: 1_168_000, // 11 680 ₽ — сумма из инцидента 2026-08-14
};

beforeEach(() => {
  h.env = {
    PAYSPACE_CARD_BUFFER_PERCENT: 20,
    CARD_ISSUE_FEE_USD_CENTS: 400,
    PAYSPACE_API_KEY: 'test-key',
    PAYSPACE_PREFLIGHT_DISABLED: false,
  };
  h.configured = true;
  h.activeCard = null;
  h.notifyStaff.mockClear();
  h.captureException.mockClear();
  h.captureMessage.mockClear();
  h.appendOrderEvent.mockClear();
  resetPreflightDedupForTests();
  h.getVccBalance.mockReset();
  h.getVccBalance.mockResolvedValue({
    balanceUsdCents: h.balanceUsdCents,
    pendingUsdCents: 0,
    currency: 'USD',
  });
});

describe('checkOrderFundingCapacity', () => {
  it('денег на счёте хватает — счёт выставлять можно', async () => {
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 20_000, pendingUsdCents: 0 });

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({ state: 'ok' });
  });

  it('денег не хватает — отказ с точной арифметикой', async () => {
    // Ровно 14 августа: на счёте $89.50, заказу нужно $124.
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 8_950, pendingUsdCents: 0 });

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toEqual({
      state: 'insufficient',
      availableUsdCents: 8_950,
      neededUsdCents: 12_400,
    });
  });

  it('замороженные деньги фонду не помогают — судим по доступному остатку', async () => {
    // `pending` у провайдера — это удержанные средства: профинансировать ими
    // карту нельзя, и пропущенный по ним заказ упал бы на выпуске.
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 8_950, pendingUsdCents: 50_000 });

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({
      state: 'insufficient',
    });
  });

  it('клиенту с живой картой комиссия за выпуск не нужна — он проходит там, где новый нет', async () => {
    // $120 на счёте: новому клиенту нужно $124 (с выпуском), владельцу живой
    // карты — $120 (только долив).
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 12_000, pendingUsdCents: 0 });
    h.activeCard = { id: 'card-1', createdAt: new Date() };

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({ state: 'ok' });
  });
});

describe('checkOrderFundingCapacity — деградация и выключатели', () => {
  it('провайдер не ответил — оплату ПРОПУСКАЕМ, а не блокируем', async () => {
    // Fail-open осознан (спека Р5): сегодня проверки нет вовсе, и чужой сбой не
    // должен останавливать нам продажи целиком. Отличается от счётчика TOTP,
    // где fail-closed — единственный барьер перебора.
    h.getVccBalance.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({ state: 'unknown' });
  });

  it('про непрочитанный фонд владелец узнаёт отдельно — молча пропускать нельзя', async () => {
    h.getVccBalance.mockRejectedValue(new Error('boom'));

    await checkOrderFundingCapacity(ORDER);

    expect(h.notifyStaff).toHaveBeenCalledTimes(1);
    expect(h.notifyStaff.mock.calls[0]?.[1]).toMatchObject({ dedupWindowMs: 60 * 60 * 1000 });
    expect(h.captureException).toHaveBeenCalled();
  });

  it('десять клиентов подряд при лежащем провайдере — одно сообщение, не десять', async () => {
    h.getVccBalance.mockRejectedValue(new Error('boom'));

    await checkOrderFundingCapacity(ORDER);
    await checkOrderFundingCapacity({ ...ORDER, id: 'other', shortId: 'CD34' });

    expect(h.notifyStaff).toHaveBeenCalledTimes(1);
    // Sentry — под тем же окном: чинили бы канал в Telegram, а топили Sentry.
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('клиент не ждёт чужой API: короткий поводок и один заход', async () => {
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 20_000, pendingUsdCents: 0 });

    await checkOrderFundingCapacity(ORDER);

    expect(h.getVccBalance).toHaveBeenCalledWith({ timeoutMs: 2000, attempts: 1 });
  });

  it('цена заказа не в долларах — гейту нечего считать, оплату не роняем', async () => {
    // `original_amount` nullable. Пустая цена — это не «фонда нет», а заказ,
    // который и выпустить-то нельзя: его поймает `issue-card`. Здесь важно
    // другое — не превратить пустое поле в 500 вместо платёжной ссылки.
    await expect(
      checkOrderFundingCapacity({ ...ORDER, originalAmount: 0 }),
    ).resolves.toMatchObject({ state: 'skipped' });
    expect(h.getVccBalance).not.toHaveBeenCalled();
  });

  it('PaySpace не настроен — проверять нечего, счёт выставляем', async () => {
    // Dev-контур: ключей нет намеренно, и гейт там не должен глушить оплату.
    h.configured = false;

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({ state: 'skipped' });
    expect(h.getVccBalance).not.toHaveBeenCalled();
  });

  it('аварийный выключатель — ЯВНЫЙ флаг, а не ноль в пороге', async () => {
    // Прецедент `VCC_BALANCE_ALERT_DISABLED`: ноль в пороге читался как
    // «настроено» и молча выключил алёрт на месяц.
    h.env.PAYSPACE_PREFLIGHT_DISABLED = true;
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 0, pendingUsdCents: 0 });

    await expect(checkOrderFundingCapacity(ORDER)).resolves.toMatchObject({ state: 'skipped' });
    expect(h.getVccBalance).not.toHaveBeenCalled();
  });
});

describe('reportFundingCapacityBlocked', () => {
  const BLOCKED = {
    state: 'insufficient' as const,
    availableUsdCents: 8_950,
    neededUsdCents: 12_400,
  };

  it('отказ остаётся следом в журнале заказа', async () => {
    // Первую неделю на проде по этим событиям считают, не режет ли гейт живые
    // оплаты. Без записи ответить на это нечем.
    await reportFundingCapacityBlocked(ORDER, BLOCKED);

    expect(h.appendOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: ORDER.id,
        eventType: 'payment_blocked_capacity',
        actorType: 'system',
      }),
    );
  });

  it('владельцу уходит арифметика: доступно, нужно, не хватает', async () => {
    // «Прямо сейчас развернули живого клиента с деньгами» — это срочнее алёрта
    // о низком балансе, и владельцу нужна цифра, а не «мало денег».
    await reportFundingCapacityBlocked(ORDER, BLOCKED);

    const text = String(h.notifyStaff.mock.calls[0]?.[0]);
    expect(text).toContain('89.50');
    expect(text).toContain('124.00');
    expect(text).toContain('34.50');
    expect(text).toContain(ORDER.shortId);
    // Масштаб развёрнутого заказа — в рублях: по нему видно, что потеряли.
    expect(text).toMatch(/11\s?680/);
  });

  it('окно молчания задано ЯВНО — иначе личка молчит вчетверо дольше Sentry', async () => {
    // У `notifyStaff` собственное окно, дефолтом ЧАС. Промолчи мы про своё —
    // Sentry писал бы каждые 15 минут, а владелец получал бы сообщение раз в
    // час: ровно расхождение, которое тикет запрещает.
    await reportFundingCapacityBlocked(ORDER, BLOCKED);

    expect(h.notifyStaff.mock.calls[0]?.[1]).toMatchObject({
      dedupWindowMs: 15 * 60 * 1000,
      capability: 'holds',
    });
  });

  it('десять отказов подряд — одно сообщение в 15 минут, Sentry под тем же окном', async () => {
    await reportFundingCapacityBlocked(ORDER, BLOCKED);
    await reportFundingCapacityBlocked({ ...ORDER, id: 'other', shortId: 'CD34' }, BLOCKED);

    expect(h.notifyStaff).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
    // Запись в журнал дедупу НЕ подчиняется: это факт про КАЖДЫЙ заказ.
    expect(h.appendOrderEvent).toHaveBeenCalledTimes(2);
  });

  it('сорванная доставка DM не роняет отказ клиенту', async () => {
    h.notifyStaff.mockRejectedValueOnce(new Error('telegram down'));

    await expect(reportFundingCapacityBlocked(ORDER, BLOCKED)).resolves.toBeUndefined();
  });

  it('недоступная база не роняет отказ клиенту', async () => {
    // Ответ клиенту важнее следа: 500 вместо честного «попробуй позже» —
    // худший исход, чем недописанное событие.
    h.appendOrderEvent.mockRejectedValueOnce(new Error('db down'));

    await expect(reportFundingCapacityBlocked(ORDER, BLOCKED)).resolves.toBeUndefined();
  });
});
