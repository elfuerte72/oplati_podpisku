import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TELEGRAM_BOT_TOKEN = '7777777:test-token';

const h = vi.hoisted(() => ({
  claimOnce: vi.fn(async () => true),
  releaseClaim: vi.fn(async () => undefined),
}));

vi.mock('@/lib/dedup', () => ({ claimOnce: h.claimOnce, releaseClaim: h.releaseClaim }));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === 'TELEGRAM_BOT_TOKEN' ? '7777777:test-token' : undefined,
    },
  ),
}));

import {
  SILENT_HINT_TTL_SECONDS,
  __resetSilentHintMemory,
  __silentHintMemorySize,
  claimSilentHint,
  releaseSilentHint,
} from './silent-hint';

/**
 * Дедуп подсказки «бот не молчит» (тикет 09).
 *
 * Два эшелона намеренно: Redis отвечает за разные процессы, память процесса —
 * за альбом. Telegram шлёт апдейт на КАЖДОЕ фото альбома, а `claimOnce`
 * fail-open (нет Redis / он завис → «право взято»), поэтому без локального
 * эшелона десять фото давали бы десять подсказок ровно там, где Redis не
 * настроен: на dev-стенде и в аварии.
 */
describe('claimSilentHint', () => {
  const t0 = 1_700_000_000_000;

  beforeEach(() => {
    h.claimOnce.mockClear();
    h.claimOnce.mockImplementation(async () => true);
    h.releaseClaim.mockClear();
    __resetSilentHintMemory();
  });

  it('первая подсказка разрешена, ключ несёт id бота и получателя', async () => {
    expect(await claimSilentHint('42', t0)).toBe(true);
    expect(h.claimOnce).toHaveBeenCalledWith(
      'tg:hint:7777777:42',
      SILENT_HINT_TTL_SECONDS,
    );
  });

  it('повтор внутри окна гасится памятью процесса даже при fail-open Redis', async () => {
    await claimSilentHint('42', t0);
    h.claimOnce.mockClear();

    expect(await claimSilentHint('42', t0 + 1_000)).toBe(false);
    // Redis не спрашиваем повторно: локального ответа достаточно.
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('альбом из десяти фото даёт ровно одну подсказку', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await claimSilentHint('42', t0 + i * 50));
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
  });

  it('после окна подсказка снова разрешена', async () => {
    await claimSilentHint('42', t0);
    expect(await claimSilentHint('42', t0 + SILENT_HINT_TTL_SECONDS * 1000 + 1)).toBe(true);
  });

  it('Redis сказал «занято» — подсказку не шлём (другой процесс уже ответил)', async () => {
    h.claimOnce.mockImplementation(async () => false);
    expect(await claimSilentHint('42', t0)).toBe(false);
  });

  it('соседний процесс уже ответил — второй раз в окне не переспрашиваем Redis', async () => {
    h.claimOnce.mockImplementation(async () => false);
    await claimSilentHint('42', t0);
    h.claimOnce.mockClear();

    expect(await claimSilentHint('42', t0 + 1_000)).toBe(false);
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('разные пользователи не гасят друг друга', async () => {
    expect(await claimSilentHint('42', t0)).toBe(true);
    expect(await claimSilentHint('43', t0)).toBe(true);
  });

  it('память процесса ограничена сверху и не течёт', async () => {
    for (let i = 0; i < 12_000; i++) {
      await claimSilentHint(`user-${i}`, t0);
    }

    // Ассерт на РАЗМЕР, а не на «новый claim работает»: последнее верно и при
    // полностью удалённой очистке, то есть ничего не проверяет.
    expect(__silentHintMemorySize()).toBeLessThanOrEqual(12_000);
    expect(__silentHintMemorySize()).toBeLessThan(11_000);
  });

  it('ПАРАЛЛЕЛЬНЫЙ альбом гасится памятью процесса, а не только Redis', async () => {
    // Telegram шлёт апдейты альбома пачкой, и Next обрабатывает их конкурентно.
    // Если локальное окно занимать ПОСЛЕ await, все десять проходят проверку до
    // первой записи — и дедуп целиком ложится на fail-open Redis.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimSilentHint('42', t0)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('право возвращается, если сообщение так и не ушло', async () => {
    expect(await claimSilentHint('42', t0)).toBe(true);

    await releaseSilentHint('42');

    // Иначе несостоявшаяся отправка запирала бы подсказку на час — ровно та
    // тишина, ради устранения которой тикет 09 и делался.
    expect(await claimSilentHint('42', t0 + 1_000)).toBe(true);
    expect(h.releaseClaim).toHaveBeenCalledWith('tg:hint:7777777:42');
  });
});
