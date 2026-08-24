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
    PAYSPACE_SAFETY_RESERVE_USD_CENTS: 0,
  } as Record<string, unknown>,
  configured: true,
  balanceUsdCents: 100_000,
  activeCard: null as { id: string; createdAt: Date } | null,
  snapshot: null as
    | { provider: string; balanceUsdCents: number; pendingUsdCents: number; readAt: Date }
    | null,
  saveSnapshot: vi.fn(async (..._args: unknown[]) => {}),
  /** Заказы, которым карту уже пообещали (обязательства фонда). */
  committed: [] as { id: string; originalAmount: number | null }[],
  /** Уже занятый фонд под чужие заказы, ещё не дошедшие до счёта. */
  reservedUsdCents: 0,
  acquireLock: vi.fn(async (..._args: unknown[]) => {}),
  insertReservation: vi.fn(async (..._args: unknown[]) => {}),
  releaseReservation: vi.fn(async (..._args: unknown[]) => {}),
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
  // Транзакция исполняет callback с тем же хендлом: атомарность проверяется на
  // реальном Postgres в `packages/db`, здесь — логика решения.
  getDb: () => ({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn({}) }),
  acquireCardFundLock: h.acquireLock,
  sumLiveCardFundReservations: vi.fn(async () => h.reservedUsdCents),
  insertCardFundReservation: h.insertReservation,
  releaseCardFundReservation: h.releaseReservation,
  findActiveByUserId: vi.fn(async () => h.activeCard),
  appendOrderEvent: h.appendOrderEvent,
  getVccBalanceSnapshot: vi.fn(async () => h.snapshot),
  findOrdersCommittingCardFund: vi.fn(async () => h.committed),
  saveVccBalanceSnapshot: h.saveSnapshot,
  VCC_SNAPSHOT_PROVIDER: 'payspace',
  PAYMENT_BLOCKED_CAPACITY_EVENT: 'payment_blocked_capacity',
}));

import {
  checkOrderFundingCapacity,
  releaseOrderFundingClaim,
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
    PAYSPACE_SAFETY_RESERVE_USD_CENTS: 0,
  };
  h.configured = true;
  h.activeCard = null;
  // Дефолт — снимка нет: сценарии со снимком включают его явно.
  h.snapshot = null;
  h.committed = [];
  h.reservedUsdCents = 0;
  h.acquireLock.mockClear();
  h.insertReservation.mockClear();
  h.releaseReservation.mockClear();
  h.saveSnapshot.mockClear();
  h.saveSnapshot.mockResolvedValue(undefined);
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
      committedUsdCents: 0,
      shortfallUsdCents: 3_450,
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
    committedUsdCents: 0,
    shortfallUsdCents: 3_450,
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

  it('обещанные карты названы отдельно — иначе цифры в сообщении не сходятся', async () => {
    // Владелец видит на счёте $200, а в сообщении «доступно $76». Без строки
    // про обещанные карты это выглядит как ошибка расчёта, и первое, что он
    // сделает, — пойдёт проверять баланс руками.
    await reportFundingCapacityBlocked(ORDER, { ...BLOCKED, committedUsdCents: 12_400 });

    const text = String(h.notifyStaff.mock.calls[0]?.[0]);
    expect(text).toContain('124.00');
    expect(text).toMatch(/обещан|занят/i);
  });

  it('без обещанных карт лишней строки в сообщении нет', async () => {
    await reportFundingCapacityBlocked(ORDER, BLOCKED);

    expect(String(h.notifyStaff.mock.calls[0]?.[0])).not.toMatch(/обещан|занят/i);
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

describe('checkOrderFundingCapacity — снимок фонда (тикет 03)', () => {
  const NOW = new Date('2026-08-19T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it('свежий снимок — судим по нему, к провайдеру не ходим вовсе', async () => {
    // Ради этого снимок и заводился: в горячем пути оплаты клиент не должен
    // ждать чужой API, а лежащий провайдер не должен останавливать продажи.
    h.snapshot = {
      provider: 'payspace',
      balanceUsdCents: 20_000,
      pendingUsdCents: 0,
      readAt: minutesAgo(5),
    };

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({ state: 'ok' });
    expect(h.getVccBalance).not.toHaveBeenCalled();
  });

  it('свежий снимок с нехваткой — отказ, тоже без похода наружу', async () => {
    h.snapshot = {
      provider: 'payspace',
      balanceUsdCents: 8_950,
      pendingUsdCents: 0,
      readAt: minutesAgo(29),
    };

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
      availableUsdCents: 8_950,
    });
    expect(h.getVccBalance).not.toHaveBeenCalled();
  });

  it('снимок из БУДУЩЕГО свежим не считается — иначе он пришпилен навсегда', async () => {
    // Часы контейнера ушли вперёд или строку положили руками со сдвинутым
    // `read_at` — и разница «сейчас минус снимок» отрицательна. Проверка «не
    // старше получаса» такую строку принимает ВЕЧНО: гейт судит по выдуманному
    // числу, а крон, который его перезапишет, до этого числа не дотянется.
    h.snapshot = {
      provider: 'payspace',
      balanceUsdCents: 999_999,
      pendingUsdCents: 0,
      readAt: new Date(NOW.getTime() + 60 * 60_000),
    };
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 8_950, pendingUsdCents: 0 });

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
    });
    expect(h.getVccBalance).toHaveBeenCalled();
  });

  it('снимок старше получаса — один живой запрос, и результат тут же сохраняется', async () => {
    // Крон бежит каждые 5 минут, значит протухший снимок означает «крон мёртв
    // или контейнер только что поднялся» — редкий случай, за который клиент не
    // должен платить ожиданием.
    h.snapshot = {
      provider: 'payspace',
      balanceUsdCents: 100,
      pendingUsdCents: 0,
      readAt: minutesAgo(31),
    };
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 20_000, pendingUsdCents: 0 });

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({ state: 'ok' });
    expect(h.getVccBalance).toHaveBeenCalledWith({ timeoutMs: 2000, attempts: 1 });
    expect(h.saveSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ balanceUsdCents: 20_000, readAt: NOW }),
    );
  });

  it('живого значения нет, а ключей провайдера нет тоже — оплату пропускаем', async () => {
    // Dev-контур: ключей PaySpace там нет намеренно. Спросить некого, и это не
    // сбой, а конфигурация.
    h.configured = false;

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'skipped',
    });
  });

  it('на контуре БЕЗ ключей гейт всё равно работает по снимку, положенному руками', async () => {
    // Требование тикета: проверку можно пройти целиком там, где ключей нет —
    // достаточно вставить строку снимка в базу. Иначе гейт нечем смотреть до
    // прода.
    h.configured = false;
    h.snapshot = {
      provider: 'payspace',
      balanceUsdCents: 8_950,
      pendingUsdCents: 0,
      readAt: minutesAgo(1),
    };

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
    });
  });

  it('сбой записи свежего значения не отменяет вердикт', async () => {
    // Снимок — оптимизация следующего запроса, а не условие этого решения.
    h.getVccBalance.mockResolvedValue({ balanceUsdCents: 20_000, pendingUsdCents: 0 });
    h.saveSnapshot.mockRejectedValueOnce(new Error('db down'));

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({ state: 'ok' });
  });
});

describe('checkOrderFundingCapacity — обязательства фонда (тикет 04)', () => {
  const NOW = new Date('2026-08-24T12:00:00.000Z');
  const freshSnapshot = (balanceUsdCents: number) => ({
    provider: 'payspace',
    balanceUsdCents,
    pendingUsdCents: 0,
    readAt: new Date(NOW.getTime() - 60_000),
  });

  it('чужие обещанные карты вычитаются: на счёте есть, а свободного нет', async () => {
    // На счёте $200, но другой клиент держит живой счёт на заказ в $100:
    // его карта уже обещана ($124), свободно лишь $76 — на второго не хватит.
    h.snapshot = freshSnapshot(20_000);
    h.committed = [{ id: 'other-order', originalAmount: 10_000 }];

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toEqual({
      state: 'insufficient',
      availableUsdCents: 7_600,
      neededUsdCents: 12_400,
      committedUsdCents: 12_400,
      shortfallUsdCents: 4_800,
    });
  });

  it('касса не закрывается целиком: дорогой заказ отказан, дешёвый проходит', async () => {
    h.snapshot = freshSnapshot(20_000);
    h.committed = [{ id: 'other-order', originalAmount: 5_000 }];

    // Свободно $200 − $64 = $136. Заказ на $100 требует $124 — проходит.
    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({ state: 'ok' });
    // А заказ на $150 требует $184 — уже нет.
    await expect(
      checkOrderFundingCapacity({ ...ORDER, originalAmount: 15_000 }, NOW),
    ).resolves.toMatchObject({ state: 'insufficient' });
  });

  it('обещания считаются по худшему случаю — как будто каждому нужна НОВАЯ карта', async () => {
    // Иначе выборка обязательств должна была бы join'ить карты клиентов с
    // окном реюза. Завышение — $4 на заказ, и оно в безопасную сторону.
    h.snapshot = freshSnapshot(20_000);
    h.committed = [{ id: 'other-order', originalAmount: 10_000 }];

    const verdict = await checkOrderFundingCapacity(ORDER, NOW);

    // $100 + 20% + $4 = $124 на чужой заказ, а не $120: комиссию за выпуск
    // считаем и ему, хотя у клиента могла быть живая карта.
    expect(verdict).toMatchObject({ committedUsdCents: 12_400 });
  });

  it('заказ без цены обязательством не считается и расчёт не роняет', async () => {
    // `original_amount` nullable. Карту такому заказу не выпустят вовсе
    // (`issue-card` завалит его с `invalid_amount`), значит и фонд он не
    // потратит — но и сложение об него спотыкаться не должно.
    h.snapshot = freshSnapshot(15_000);
    h.committed = [
      { id: 'no-price', originalAmount: null },
      { id: 'normal', originalAmount: 5_000 },
    ];

    // Обещано только $64 (за заказ на $50), пустой заказ не добавил ничего —
    // и не превратил сумму в NaN, отказав всем подряд.
    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
      committedUsdCents: 6_400,
      availableUsdCents: 8_600,
    });
  });

  it('страховой запас отодвигает границу, не трогая код', async () => {
    h.env.PAYSPACE_SAFETY_RESERVE_USD_CENTS = 5_000;
    h.snapshot = freshSnapshot(15_000);

    // $150 − $50 запаса = $100 свободно, а заказу нужно $124.
    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
      availableUsdCents: 10_000,
    });
  });

  it('свободное не уходит в минус — владельцу показываем ноль, а не «минус двести»', async () => {
    h.snapshot = freshSnapshot(1_000);
    h.committed = [{ id: 'other', originalAmount: 50_000 }];

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
      availableUsdCents: 0,
    });
  });

  it('НЕХВАТКА считается по настоящему дефициту, а не по показанному нулю', async () => {
    // Обещано больше, чем лежит на счёте: свободного $0, но пополнить надо не
    // на «нужную сумму заказа», а на дыру целиком. Скажи владельцу «не хватает
    // $124» — он пополнит ровно столько, и гейт продолжит отказывать.
    h.snapshot = freshSnapshot(10_000); // $100 на счёте
    h.committed = [{ id: 'other', originalAmount: 20_000 }]; // обещано $244

    const verdict = await checkOrderFundingCapacity(ORDER, NOW);

    expect(verdict).toMatchObject({
      state: 'insufficient',
      availableUsdCents: 0,
      neededUsdCents: 12_400,
      // -14 400 свободного + 12 400 нужных = дыра в 26 800 центов.
      shortfallUsdCents: 26_800,
    });
  });
});

describe('claimOrderFundingCapacity — занятие фонда (тикет 05)', () => {
  const NOW = new Date('2026-08-24T12:00:00.000Z');
  const freshSnap = (balanceUsdCents: number) => ({
    provider: 'payspace',
    balanceUsdCents,
    pendingUsdCents: 0,
    readAt: new Date(NOW.getTime() - 60_000),
  });

  it('пропуск ЗАНИМАЕТ деньги под этот заказ, а не просто разрешает', async () => {
    // Иначе между гейтом и созданием счёта остаётся окно, в котором второй
    // клиент видит те же свободные деньги: статус заказа меняется только ПОСЛЕ
    // ответа платёжного шлюза.
    h.snapshot = freshSnap(20_000);

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({ state: 'ok' });

    expect(h.insertReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: ORDER.id, amountUsdCents: 12_400 }),
    );
  });

  it('расчёт идёт ПОД замком — иначе двое считают по одному и тому же снимку', async () => {
    h.snapshot = freshSnap(20_000);

    await checkOrderFundingCapacity(ORDER, NOW);

    expect(h.acquireLock).toHaveBeenCalled();
  });

  it('чужое занятие вычитается наравне с обещанными картами', async () => {
    // Сосед прошёл гейт полсекунды назад: счёта у него ещё нет, статус прежний,
    // и по статусам он невидим — видно только занятие.
    h.snapshot = freshSnap(20_000);
    h.reservedUsdCents = 12_400;

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'insufficient',
      availableUsdCents: 7_600,
    });
    expect(h.insertReservation).not.toHaveBeenCalled();
  });

  it('отказ денег НЕ занимает', async () => {
    h.snapshot = freshSnap(1_000);

    await checkOrderFundingCapacity(ORDER, NOW);

    expect(h.insertReservation).not.toHaveBeenCalled();
  });

  it('срок занятия равен сроку счёта — фонд не заперт дольше платёжного документа', async () => {
    h.snapshot = freshSnap(20_000);

    await checkOrderFundingCapacity(ORDER, NOW);

    const [, reservation] = h.insertReservation.mock.calls[0] as unknown as [
      unknown,
      { expiresAt: Date },
    ];
    // У текущего шлюза счёт живёт час.
    expect(reservation.expiresAt.getTime()).toBe(NOW.getTime() + 60 * 60_000);
  });

  it('не удалось занять деньги — ОТКАЗ, а не тихий пропуск', async () => {
    // ⚠️ Здесь fail-CLOSED, в отличие от непрочитанного баланса. Таймаут замка
    // означает очередь из таких же claim'ов, то есть РОВНО ту гонку, ради
    // которой замок и стоит: пропусти мы оплату — защита выключалась бы сама
    // именно под нагрузкой, и фонд продавался бы дважды. Клиент видит ту же
    // «техническую паузу» и возвращается через десять минут; заказ жив.
    h.snapshot = freshSnap(20_000);
    h.acquireLock.mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    );

    await expect(checkOrderFundingCapacity(ORDER, NOW)).resolves.toMatchObject({
      state: 'busy',
    });
    expect(h.insertReservation).not.toHaveBeenCalled();
  });

  it('о перегруженной кассе владелец узнаёт ОТДЕЛЬНО от недоступного провайдера', async () => {
    // Иначе шторм таймаутов вытеснит настоящий алёрт «PaySpace не отвечает»:
    // окно дедупа общее, и владелец час получал бы неверную причину.
    h.snapshot = freshSnap(20_000);
    h.acquireLock.mockRejectedValueOnce(
      Object.assign(new Error('lock timeout'), { code: '55P03' }),
    );

    await checkOrderFundingCapacity(ORDER, NOW);

    const text = String(h.notifyStaff.mock.calls[0]?.[0]);
    expect(text).not.toMatch(/прочитать карточный счёт/i);
    expect(h.notifyStaff.mock.calls[0]?.[1]).toMatchObject({ dedupKey: 'preflight_busy_staff' });
  });

  it('гейт выключен — фонд не занимается вовсе', async () => {
    h.env.PAYSPACE_PREFLIGHT_DISABLED = true;

    await checkOrderFundingCapacity(ORDER, NOW);

    expect(h.insertReservation).not.toHaveBeenCalled();
    expect(h.acquireLock).not.toHaveBeenCalled();
  });
});

describe('releaseOrderFundingClaim', () => {
  it('неудачный счёт освобождает деньги сразу', async () => {
    await releaseOrderFundingClaim(ORDER.id);

    expect(h.releaseReservation).toHaveBeenCalledWith(expect.anything(), ORDER.id);
  });

  it('сбой освобождения не роняет обработку ошибки счёта', async () => {
    // Мы уже в catch: вторая ошибка поверх первой лишит клиента внятного
    // ответа, а деньги всё равно освободятся по сроку.
    h.releaseReservation.mockRejectedValueOnce(new Error('db down'));

    await expect(releaseOrderFundingClaim(ORDER.id)).resolves.toBeUndefined();
  });
});
