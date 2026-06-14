import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({ limitMock: vi.fn() }));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    // конструктор принимает { url, token } — для мока тело не нужно
  },
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow() {
      return { kind: 'sliding' };
    }
    limit(id: string) {
      return h.limitMock(id);
    }
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

async function loadModule() {
  return await import('./ratelimit.ts');
}

function setUpstashEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
}

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.resetModules();
    h.limitMock.mockReset();
    delete process.env.RATE_LIMIT_DISABLED;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_DISABLED;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  it('выключатель RATE_LIMIT_DISABLED → allowed, backend не дёргается', async () => {
    process.env.RATE_LIMIT_DISABLED = '1';
    setUpstashEnv(); // даже при заданном Upstash
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('web-chat', '1.2.3.4');

    expect(res.allowed).toBe(true);
    expect(res.configured).toBe(false);
    expect(h.limitMock).not.toHaveBeenCalled();
  });

  it('Upstash не сконфигурирован → fail-open (allowed, configured=false)', async () => {
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('telegram', 'tg-42');

    expect(res.allowed).toBe(true);
    expect(res.configured).toBe(false);
    expect(h.limitMock).not.toHaveBeenCalled();
  });

  it('сконфигурирован, под лимитом → allowed', async () => {
    setUpstashEnv();
    h.limitMock.mockResolvedValue({ success: true, limit: 12, remaining: 11, reset: 0, pending: Promise.resolve() });
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('web-chat', '1.2.3.4');

    expect(res.allowed).toBe(true);
    expect(res.configured).toBe(true);
    expect(res.remaining).toBe(11);
    expect(h.limitMock).toHaveBeenCalledWith('1.2.3.4');
  });

  it('фолбэк на KV_REST_API_* (имена от интеграции Vercel) → сконфигурирован', async () => {
    // Только KV_*-имена, без UPSTASH_* — как инжектит Vercel Marketplace.
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'kv-test-token';
    h.limitMock.mockResolvedValue({ success: true, limit: 12, remaining: 11, reset: 0, pending: Promise.resolve() });
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('web-chat', '5.6.7.8');

    expect(res.allowed).toBe(true);
    expect(res.configured).toBe(true);
    expect(h.limitMock).toHaveBeenCalledWith('5.6.7.8');
  });

  it('сконфигурирован, лимит превышен → blocked', async () => {
    setUpstashEnv();
    h.limitMock.mockResolvedValue({ success: false, limit: 12, remaining: 0, reset: 0, pending: Promise.resolve() });
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('web-chat', '1.2.3.4');

    expect(res.allowed).toBe(false);
    expect(res.configured).toBe(true);
  });

  it('ошибка backend → fail-open (allowed)', async () => {
    setUpstashEnv();
    h.limitMock.mockRejectedValue(new Error('upstash down'));
    const { checkRateLimit } = await loadModule();

    const res = await checkRateLimit('telegram', 'tg-7');

    expect(res.allowed).toBe(true);
    expect(res.configured).toBe(false);
  });
});
