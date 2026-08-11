import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  set: vi.fn(async (..._args: unknown[]) => 'OK' as string | null),
  env: { url: 'https://redis.test' as string | undefined, token: 'tok' as string | undefined },
  captureException: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    set = h.set;
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException }));
vi.mock('./env.server.ts', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'UPSTASH_REDIS_REST_URL') return h.env.url;
        if (prop === 'UPSTASH_REDIS_REST_TOKEN') return h.env.token;
        return undefined;
      },
    },
  ),
}));

import { claimOnce, extendClaim } from './dedup.ts';

/**
 * Дедуп повторных доставок (аудит 2026-08-10). Ключевое здесь — НАПРАВЛЕНИЕ
 * отказа: при недоступном хранилище право считается взятым, потому что потерять
 * апдейт хуже, чем обработать его дважды.
 */
describe('claimOnce', () => {
  beforeEach(() => {
    h.set.mockClear();
    h.set.mockResolvedValue('OK');
    h.captureException.mockClear();
    h.env.url = 'https://redis.test';
    h.env.token = 'tok';
  });

  it('первый вызов берёт право', async () => {
    await expect(claimOnce('k1', 600)).resolves.toBe(true);
    expect(h.set).toHaveBeenCalledWith('k1', '1', { nx: true, ex: 600 });
  });

  it('занятый ключ — это дубль', async () => {
    h.set.mockResolvedValueOnce(null);
    await expect(claimOnce('k2', 600)).resolves.toBe(false);
  });

  it('сбой Redis — fail-open, но с алёртом', async () => {
    h.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimOnce('k3', 600)).resolves.toBe(true);
    expect(h.captureException).toHaveBeenCalled();
  });

  it('незаданный Redis — fail-open без единого запроса', async () => {
    // Ветка живёт на dev-стенде и локально; молча «дедуплицировать всё» она бы
    // означала бота, который не отвечает вообще.
    vi.resetModules();
    h.env.url = undefined;
    const { claimOnce: fresh } = await import('./dedup.ts');
    await expect(fresh('k4', 600)).resolves.toBe(true);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('зависший Redis не держит бота: fail-open по своему таймауту', async () => {
    // claim стоит ПЕРЕД обработчиком, поэтому медленное хранилище останавливает
    // весь бот, включая платёжные флоу, которым Redis не нужен вовсе.
    vi.useFakeTimers();
    h.set.mockImplementationOnce(() => new Promise<string | null>(() => {}));
    const promise = claimOnce('k5', 600);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('продление ставит новый срок без NX', async () => {
    await extendClaim('k6', 600);
    expect(h.set).toHaveBeenCalledWith('k6', '1', { ex: 600 });
  });
});
