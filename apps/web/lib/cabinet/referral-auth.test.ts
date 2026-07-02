import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// Telegram-путь (initData) — резолвер мини-аппа.
const cabinetAuth = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./auth.ts', () => ({ resolveCabinetUser: cabinetAuth.fn }));

// Web-путь — cookie-сессия.
const session = vi.hoisted(() => ({ id: 'web-sess-1', fn: vi.fn() }));
vi.mock('../chat/session.ts', () => ({
  getOrCreateWebSessionId: () => session.fn(),
}));

const dbState = vi.hoisted(() => ({
  user: { id: 'u-web', created: false },
  profile: { telegramLinked: false } as { telegramLinked: boolean } | null,
  throws: false,
  lastInput: null as { webSessionId: string; referredBy?: string | null } | null,
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getOrCreateUserByWebSessionId: vi.fn(
    async (_db: unknown, input: { webSessionId: string; referredBy?: string | null }) => {
      dbState.lastInput = input;
      if (dbState.throws) throw new Error('db down');
      return dbState.user;
    },
  ),
  getUserProfileById: vi.fn(async () => dbState.profile),
}));

import { resolveReferralRequester } from './referral-auth.ts';

beforeEach(() => {
  vi.clearAllMocks();
  session.fn.mockResolvedValue('web-sess-1');
  dbState.user = { id: 'u-web', created: false };
  dbState.profile = { telegramLinked: false };
  dbState.throws = false;
  dbState.lastInput = null;
});

describe('resolveReferralRequester — мини-апп (initData)', () => {
  it('валидный initData → telegram-личность (linked, rate-limit telegram)', async () => {
    cabinetAuth.fn.mockResolvedValue({ ok: true, user: { userId: 'u-tg', telegramId: '12345', user: {} } });
    const res = await resolveReferralRequester('init-data-blob');
    expect(res).toEqual({
      ok: true,
      requester: {
        userId: 'u-tg',
        telegramLinked: true,
        surface: 'miniapp',
        rateLimit: { name: 'telegram', id: '12345' },
      },
    });
  });

  it('плохая подпись → проброс статуса/ошибки', async () => {
    cabinetAuth.fn.mockResolvedValue({ ok: false, status: 401, error: 'bad_signature' });
    const res = await resolveReferralRequester('bad');
    expect(res).toEqual({ ok: false, status: 401, error: 'bad_signature' });
  });
});

describe('resolveReferralRequester — сайт (web-сессия)', () => {
  it('без initData → web-юзер по cookie, rate-limit web-chat', async () => {
    dbState.profile = { telegramLinked: false };
    const res = await resolveReferralRequester(undefined);
    expect(res).toEqual({
      ok: true,
      requester: {
        userId: 'u-web',
        telegramLinked: false,
        surface: 'web',
        rateLimit: { name: 'web-chat', id: 'web-sess-1' },
      },
    });
    // Telegram-резолвер не дёргался.
    expect(cabinetAuth.fn).not.toHaveBeenCalled();
  });

  it('привязанная веб-сессия → telegramLinked=true', async () => {
    dbState.profile = { telegramLinked: true };
    const res = await resolveReferralRequester(undefined);
    expect(res.ok && res.requester.telegramLinked).toBe(true);
  });

  it('веб-юзер создаётся всегда без реферера (захват — только Telegram deep-link)', async () => {
    await resolveReferralRequester(undefined);
    expect(dbState.lastInput).toEqual({ webSessionId: 'web-sess-1', referredBy: null });
  });

  it('профиль не найден → telegramLinked=false (консервативно)', async () => {
    dbState.profile = null;
    const res = await resolveReferralRequester(undefined);
    expect(res.ok && res.requester.telegramLinked).toBe(false);
  });

  it('сбой БД → 503 db_unavailable', async () => {
    dbState.throws = true;
    const res = await resolveReferralRequester(undefined);
    expect(res).toEqual({ ok: false, status: 503, error: 'db_unavailable' });
  });
});
