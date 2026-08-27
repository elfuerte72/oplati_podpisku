import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Памятка счётчиков меню (редизайн, тикет 02, правки по ревью). Семантика
 * тонкая и уже переписывалась дважды — регресс здесь выглядит как «зелёная
 * панель, мёртвый счётчик», и `pnpm test` обязан его ловить.
 */

const countPending = vi.fn<() => Promise<{ count: number; sumKopecks: number }>>();
const countSupport = vi.fn<() => Promise<number>>();
const captureException = vi.fn();

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  countPendingOrdersForPanel: () => countPending(),
  countUnansweredSupportRequests: () => countSupport(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import {
  invalidateMenuCounts,
  readMenuCounts,
  readPendingTotals,
  readUnansweredSupportCount,
} from './menu-counts';

const T0 = 1_000_000;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('memo счётчиков меню', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidateMenuCounts();
    countPending.mockReset();
    countSupport.mockReset();
    captureException.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('стол и меню одного рендера делят один запрос', async () => {
    countSupport.mockResolvedValue(3);

    const [a, b] = await Promise.all([
      readUnansweredSupportCount(T0),
      readUnansweredSupportCount(T0 + 10),
    ]);

    expect(a).toBe(3);
    expect(b).toBe(3);
    expect(countSupport).toHaveBeenCalledTimes(1);
  });

  it('по истечении срока памятки запрос уходит заново', async () => {
    countSupport.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    expect(await readUnansweredSupportCount(T0)).toBe(1);
    expect(await readUnansweredSupportCount(T0 + 31_000)).toBe(0);
    expect(countSupport).toHaveBeenCalledTimes(2);
  });

  it('отказ базы — это null, он не запоминается и уходит в Sentry один раз за окно', async () => {
    countPending.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({
      count: 2,
      sumKopecks: 100,
    });

    expect(await readPendingTotals(T0)).toBeNull();
    // Следующий рендер спрашивает снова — неудача не держится весь срок.
    expect(await readPendingTotals(T0 + 100)).toEqual({ count: 2, sumKopecks: 100 });
    expect(countPending).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('повторные отказы внутри окна не бьют в Sentry каждым рендером', async () => {
    countPending.mockRejectedValue(new Error('ECONNREFUSED'));

    await readPendingTotals(T0);
    await readPendingTotals(T0 + 1_000);
    await readPendingTotals(T0 + 2_000);

    expect(captureException).toHaveBeenCalledTimes(1);
    // А по истечении окна — снова один сигнал: база всё ещё лежит.
    await readPendingTotals(T0 + 11 * 60_000);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('медленный запрос гасит число по дедлайну, но не плодит новых запросов', async () => {
    const slow = deferred<number>();
    countSupport.mockReturnValue(slow.promise);

    const first = readUnansweredSupportCount(T0);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await first).toBeNull();

    // Второй рендер — даже ПОСЛЕ срока памятки — ждёт тот же запрос, а не
    // запускает ещё один на стоящей базе.
    const second = readUnansweredSupportCount(T0 + 40_000);
    expect(countSupport).toHaveBeenCalledTimes(1);

    slow.resolve(7);
    expect(await second).toBe(7);
  });

  it('ответ клиенту сбрасывает памятку — следующий рендер видит свежее число', async () => {
    countSupport.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    expect(await readUnansweredSupportCount(T0)).toBe(1);
    invalidateMenuCounts('support');
    expect(await readUnansweredSupportCount(T0 + 1_000)).toBe(0);
  });

  it('readMenuCounts спрашивает только разделы, открытые роли', async () => {
    countPending.mockResolvedValue({ count: 4, sumKopecks: 0 });
    countSupport.mockResolvedValue(2);

    expect(await readMenuCounts('operator')).toEqual({ pending: 4, support: 2 });
    expect(await readMenuCounts('supervisor')).toEqual({ pending: null, support: null });
    // Для супервизора в базу не ходили: числа по закрытым разделам не считаются.
    expect(countPending).toHaveBeenCalledTimes(1);
    expect(countSupport).toHaveBeenCalledTimes(1);
  });
});
