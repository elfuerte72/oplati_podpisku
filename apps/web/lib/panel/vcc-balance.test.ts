import { beforeEach, describe, expect, it, vi } from 'vitest';

type BalanceReadOptions = { timeoutMs?: number; attempts?: number } | undefined;

const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getVccBalance: vi.fn(async (_opts?: { timeoutMs?: number; attempts?: number }) => ({
    balanceUsdCents: 12_000,
    pendingUsdCents: 0,
    currency: 'USD',
  })),
  captureException: vi.fn(),
  threshold: 5000,
}));

vi.mock('@/lib/pay-space', () => ({
  isPaySpaceConfigured: h.isConfigured,
  getPaySpaceClient: () => ({ getVccBalance: h.getVccBalance }),
}));

// Порог экран берёт ТОЙ ЖЕ функцией, что и алёрт: своё чтение env означало бы
// спор экрана с кроном о том, когда бить тревогу.
vi.mock('@/lib/jobs/vcc-balance', () => ({
  vccAlertThresholdsUsdCents: () => ({ critical: h.threshold, low: h.threshold * 10 }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.captureException,
  captureMessage: vi.fn(),
}));

import { readVccBalanceForPanel, resetVccBalanceCacheForTests } from './vcc-balance';

const NOW = new Date('2026-08-18T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/**
 * Остаток карточного счёта на видном месте (тикет 05). 14 августа его нехватка
 * уронила оплаченный заказ на 11 680 ₽, а пополнение приходит только T+1 —
 * поэтому ценность в том, чтобы увидеть цифру заранее.
 */
describe('readVccBalanceForPanel', () => {
  beforeEach(() => {
    h.isConfigured.mockReturnValue(true);
    // ⚠️ Именно mockClear, а не только mockImplementation: `clearMocks` в
    // конфиге выключен, и без сброса ИСТОРИИ ассерт по `mock.calls` читал бы
    // вызов соседнего теста — тест зеленел бы, даже если этот сценарий вообще
    // ничего не вызывает (находка ревью).
    h.getVccBalance.mockClear();
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 12_000,
      pendingUsdCents: 0,
      currency: 'USD',
    }));
    h.captureException.mockClear();
    h.threshold = 5000;
    resetVccBalanceCacheForTests();
  });

  it('нормальный баланс отдаётся с порогом и без тревоги', async () => {
    expect(await readVccBalanceForPanel(NOW)).toMatchObject({
      state: 'ok',
      balanceUsdCents: 12_000,
      pendingUsdCents: 0,
      thresholdUsdCents: 5000,
      low: false,
    });
  });

  it('баланс ниже порога помечается', async () => {
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 4000,
      pendingUsdCents: 0,
      currency: 'USD',
    }));

    expect(await readVccBalanceForPanel(NOW)).toMatchObject({ low: true });
  });

  it('порог берётся из ТОГО ЖЕ места, что и алёрт', async () => {
    h.threshold = 20_000;

    expect(await readVccBalanceForPanel(NOW)).toMatchObject({
      thresholdUsdCents: 20_000,
      low: true,
    });
  });

  it('экран подсвечивает по ТОМУ ЖЕ порогу, что бьёт крон', async () => {
    // Тикет 11 переопределил `0` в env как «считать относительно». Экран со
    // своим прежним «0 = выключено» показывал бы «всё спокойно» при пустом
    // счёте — ровно тогда, когда крон уже кричит.
    h.threshold = 12_400;
    h.getVccBalance.mockImplementation(async () => ({
      balanceUsdCents: 1,
      pendingUsdCents: 0,
      currency: 'USD',
    }));

    expect(await readVccBalanceForPanel(NOW)).toMatchObject({
      low: true,
      thresholdUsdCents: 12_400,
    });
  });

  it('недоступный провайдер не роняет страницу', async () => {
    h.getVccBalance.mockImplementation(async () => {
      throw new Error('provider is down');
    });

    expect(await readVccBalanceForPanel(NOW)).toEqual({ state: 'unavailable' });
    // Молчать нельзя: экран покажет «баланс не получен», а разбираться будем
    // по следу в Sentry.
    expect(h.captureException).toHaveBeenCalled();
  });

  it('PaySpace не настроен — это отдельное состояние, а не сбой', async () => {
    h.isConfigured.mockReturnValue(false);

    expect(await readVccBalanceForPanel(NOW)).toEqual({ state: 'not_configured' });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('баланс читается со СВОИМ коротким дедлайном и без ретраев', async () => {
    await readVccBalanceForPanel(NOW);

    expect(h.getVccBalance).toHaveBeenCalledTimes(1);
    const opts: BalanceReadOptions = h.getVccBalance.mock.calls.at(-1)?.[0];
    expect(opts?.attempts).toBe(1);
    // Дефолт клиента — 60 с на фазу: экран, который перерисовывается каждые
    // 25 с, столько ждать не может. Точное число здесь не важно, важно, что
    // оно СУЩЕСТВЕННО меньше дефолта.
    expect(opts?.timeoutMs).toBeGreaterThan(0);
    expect(opts?.timeoutMs).toBeLessThan(10_000);
  });

  it('живое обновление не долбит провайдера: значение кэшируется', async () => {
    await readVccBalanceForPanel(NOW);
    await readVccBalanceForPanel(later(10_000));
    await readVccBalanceForPanel(later(20_000));

    // Экран обновляется раз в 25 с; без кэша одна открытая вкладка давала бы
    // 144 запроса в чужой API за час ради числа, которое меняется раз в сутки.
    expect(h.getVccBalance).toHaveBeenCalledTimes(1);
  });

  it('кэш протухает — значение перечитывается', async () => {
    await readVccBalanceForPanel(NOW);
    await readVccBalanceForPanel(later(61_000));

    expect(h.getVccBalance).toHaveBeenCalledTimes(2);
  });

  it('медленный провайдер: показываем ПРЕЖНЕЕ число с пометкой, а не прочерк', async () => {
    await readVccBalanceForPanel(NOW);
    h.getVccBalance.mockImplementation(async () => {
      throw abortError();
    });

    const res = await readVccBalanceForPanel(later(61_000));

    // Экран заводился ради того, чтобы увидеть нехватку ЗАРАНЕЕ. «Баланс не
    // получен» вместо числа — потеря ровно этой возможности.
    expect(res).toMatchObject({ state: 'stale', balanceUsdCents: 12_000 });
    expect((res as { readAt: Date }).readAt.toISOString()).toBe(NOW.toISOString());
  });

  it('таймаут провайдера НЕ шлёт Sentry-ошибку', async () => {
    // Страница живая (обновление раз в 25 с). Ошибка на каждый отказ — это
    // сотня событий в час с одной вкладки; так и был заглушён алёрт баланса.
    h.getVccBalance.mockImplementation(async () => {
      throw abortError();
    });

    expect(await readVccBalanceForPanel(NOW)).toEqual({ state: 'unavailable' });
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('слишком старое значение уже не показывается', async () => {
    await readVccBalanceForPanel(NOW);
    h.getVccBalance.mockImplementation(async () => {
      throw abortError();
    });

    // Полчаса — предел: дальше число врёт о деньгах, а это хуже прочерка.
    expect(await readVccBalanceForPanel(later(31 * 60_000))).toEqual({ state: 'unavailable' });
  });
});
