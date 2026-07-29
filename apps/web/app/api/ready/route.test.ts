import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({
  pingDb: vi.fn(async () => {}),
  getAppliedMigrations: vi.fn(
    async (): Promise<{ count: number; latestWhen: number | null }> => ({
      count: 0,
      latestWhen: 0,
    }),
  ),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as never,
  pingDb: (...args: unknown[]) => h.pingDb(...(args as [])),
  getAppliedMigrations: (...args: unknown[]) => h.getAppliedMigrations(...(args as [])),
}));

/** Журнал образа: две миграции, свежая — `when: 2000`. */
vi.mock('@oplati/db/migrations-journal', () => ({
  default: {
    version: '7',
    dialect: 'postgresql',
    entries: [
      { idx: 0, version: '7', when: 1000, tag: '0000_a', breakpoints: true },
      { idx: 1, version: '7', when: 2000, tag: '0001_b', breakpoints: true },
    ],
  },
}));

const { GET } = await import('./route.ts');

beforeEach(() => {
  h.pingDb.mockReset().mockResolvedValue(undefined);
  h.getAppliedMigrations.mockReset().mockResolvedValue({ count: 2, latestWhen: 2000 });
});

describe('GET /api/ready', () => {
  it('БД отвечает и миграции применены → 200 ok', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('миграции отстают → 503 migrations_pending', async () => {
    // Ровно инцидент 2026-07-28: код Freekassa на проде, миграций нет.
    h.getAppliedMigrations.mockResolvedValue({ count: 1, latestWhen: 1000 });
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      status: 'degraded',
      reasons: ['migrations_pending'],
    });
  });

  it('журнала миграций в БД нет вовсе → тоже migrations_pending', async () => {
    h.getAppliedMigrations.mockResolvedValue({ count: 0, latestWhen: null });
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('БД впереди кода (середина отката) → отдельная причина, не «забыли db:migrate»', async () => {
    h.getAppliedMigrations.mockResolvedValue({ count: 3, latestWhen: 3000 });
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      status: 'degraded',
      reasons: ['migrations_ahead'],
    });
  });

  it('БД недоступна → 503 db_unreachable', async () => {
    h.pingDb.mockRejectedValue(new Error('getaddrinfo ENOTFOUND oplatishka-db-typo'));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      status: 'degraded',
      reasons: ['db_unreachable'],
    });
  });

  it('наружу не утекают хеши, счётчики и имена миграций — репозиторий публичный', async () => {
    h.getAppliedMigrations.mockResolvedValue({ count: 1, latestWhen: 1000 });
    const body = JSON.stringify(await (await GET()).json());
    expect(body).not.toContain('1000');
    expect(body).not.toContain('0001_b');
  });
});
