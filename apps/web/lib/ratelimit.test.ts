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

describe('getClientIp (M3: анти-спуфинг)', () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://example.com/api', { headers });
  }

  it('приоритет доверенного x-real-ip над подделанным x-forwarded-for', async () => {
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-forwarded-for': '6.6.6.6, 10.0.0.1', // левый элемент — подделка клиента
      'x-real-ip': '203.0.113.5', // Vercel проставил реальный адрес соединения
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('ротация X-Forwarded-For не обходит лимит, пока есть x-real-ip', async () => {
    const { getClientIp } = await loadModule();
    const a = getClientIp(reqWith({ 'x-forwarded-for': 'spoof-1', 'x-real-ip': '203.0.113.5' }));
    const b = getClientIp(reqWith({ 'x-forwarded-for': 'spoof-2', 'x-real-ip': '203.0.113.5' }));
    expect(a).toBe('203.0.113.5');
    expect(b).toBe('203.0.113.5'); // одинаковый ключ → per-IP окно не сбрасывается
  });

  it('fallback без x-real-ip: берёт ПРАВЫЙ (доверенный) элемент x-forwarded-for', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('нет заголовков → "unknown"', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({}))).toBe('unknown');
  });
});

describe('getClientIp за реверс-прокси (X-Client-IP за секретом)', () => {
  // За российским VPS-прокси Vercel затирает x-real-ip/x-forwarded-for на IP
  // прокси (адрес соединения) — эмпирически проверено. Реальный посетитель — в
  // кастомном X-Client-IP; верим ему только при секрете X-Proxy-Secret:
  // *.vercel.app принимает трафик мимо прокси, где оба заголовка подделает
  // любой клиент (CWE-348).
  const PROXY_SECRET = 'timeweb-proxy-shared-secret';

  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://example.com/api', { headers });
  }

  beforeEach(() => {
    vi.resetModules();
    delete process.env.PROXY_SHARED_SECRET;
  });

  afterEach(() => {
    delete process.env.PROXY_SHARED_SECRET;
    vi.resetModules();
  });

  it('секрет совпал → берёт X-Client-IP, а не x-real-ip (= IP прокси)', async () => {
    process.env.PROXY_SHARED_SECRET = PROXY_SECRET;
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-client-ip': '198.51.100.7', // реальный посетитель
      'x-proxy-secret': PROXY_SECRET,
      'x-real-ip': '104.171.133.70', // IP прокси (Vercel видит адрес соединения)
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('неверный секрет (спуфинг мимо прокси через *.vercel.app) → x-real-ip', async () => {
    process.env.PROXY_SHARED_SECRET = PROXY_SECRET;
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-client-ip': '6.6.6.6', // подделка клиента
      'x-proxy-secret': 'wrong-secret',
      'x-real-ip': '203.0.113.5',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('ротация подделанного X-Client-IP без секрета не сбрасывает per-IP ключ', async () => {
    process.env.PROXY_SHARED_SECRET = PROXY_SECRET;
    const { getClientIp } = await loadModule();
    const a = getClientIp(reqWith({ 'x-client-ip': 'spoof-1', 'x-real-ip': '203.0.113.5' }));
    const b = getClientIp(reqWith({ 'x-client-ip': 'spoof-2', 'x-real-ip': '203.0.113.5' }));
    expect(a).toBe('203.0.113.5');
    expect(b).toBe('203.0.113.5');
  });

  it('PROXY_SHARED_SECRET не задан → прокси-заголовки игнорируются (ветка мертва)', async () => {
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-client-ip': '6.6.6.6',
      'x-proxy-secret': 'anything',
      'x-real-ip': '203.0.113.5',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('секрет совпал, но X-Client-IP пуст → fallback на x-real-ip', async () => {
    process.env.PROXY_SHARED_SECRET = PROXY_SECRET;
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-proxy-secret': PROXY_SECRET,
      'x-real-ip': '203.0.113.5',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });
});

describe('getClientIp за Dokploy-Traefik (CLIENT_IP_MODE=traefik)', () => {
  // Self-host (docs/dokploy-migration-plan.md): Traefik пропускает клиентский
  // `x-real-ip` насквозь, не затирая, — доверять ему нельзя (CWE-348, обход
  // per-IP лимита ротацией заголовка). Доверенный источник — ПРАВЫЙ элемент
  // `x-forwarded-for` (его пишет сам Traefik из адреса соединения).
  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://example.com/api', { headers });
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.CLIENT_IP_MODE = 'traefik';
  });

  afterEach(() => {
    delete process.env.CLIENT_IP_MODE;
    vi.resetModules();
  });

  it('подделанный x-real-ip игнорируется — берётся правый элемент XFF', async () => {
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-real-ip': '6.6.6.6', // клиентская подделка — Traefik её НЕ затирает
      'x-forwarded-for': '203.0.113.9', // а это пишет сам Traefik
    });
    expect(getClientIp(req)).toBe('203.0.113.9');
  });

  it('ротация левых элементов XFF не сбрасывает per-IP ключ', async () => {
    const { getClientIp } = await loadModule();
    const a = getClientIp(reqWith({ 'x-forwarded-for': 'spoof-1, 203.0.113.9' }));
    const b = getClientIp(reqWith({ 'x-forwarded-for': 'spoof-2, 203.0.113.9' }));
    expect(a).toBe('203.0.113.9');
    expect(b).toBe('203.0.113.9');
  });

  it('ротация x-real-ip не сбрасывает per-IP ключ', async () => {
    const { getClientIp } = await loadModule();
    const a = getClientIp(reqWith({ 'x-real-ip': 'spoof-1', 'x-forwarded-for': '203.0.113.9' }));
    const b = getClientIp(reqWith({ 'x-real-ip': 'spoof-2', 'x-forwarded-for': '203.0.113.9' }));
    expect(a).toBe('203.0.113.9');
    expect(b).toBe('203.0.113.9');
  });

  it('нет XFF → "unknown" (не падаем и не берём x-real-ip)', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-real-ip': '6.6.6.6' }))).toBe('unknown');
  });

  it('CLIENT_IP_MODE не задан → прежняя Vercel-логика (x-real-ip в приоритете)', async () => {
    delete process.env.CLIENT_IP_MODE;
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-real-ip': '203.0.113.5',
      'x-forwarded-for': '6.6.6.6, 10.0.0.1',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('CLIENT_IP_MODE="" → дефолт vercel (пустая строка не ломает env-схему)', async () => {
    process.env.CLIENT_IP_MODE = '';
    const { getClientIp } = await loadModule();
    const req = reqWith({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '6.6.6.6' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });
});

describe('getClientIp: нормализация значения в IP', () => {
  // Без нормализации `host:port` от прокси давал бы НОВУЮ identity на каждом
  // соединении (эфемерный порт), полностью обходя per-IP лимит — cost-DoS на
  // строки БД и дневной AI-бюджет.
  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://example.com/api', { headers });
  }

  beforeEach(() => {
    vi.resetModules();
    delete process.env.PROXY_SHARED_SECRET;
    process.env.CLIENT_IP_MODE = 'traefik';
  });

  afterEach(() => {
    delete process.env.CLIENT_IP_MODE;
    vi.resetModules();
  });

  it('IPv4 с портом → identity без порта, ротация порта НЕ создаёт новый ключ', async () => {
    const { getClientIp } = await loadModule();
    const a = getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9:56789' }));
    const b = getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9:41022' }));
    expect(a).toBe('203.0.113.9');
    expect(b).toBe('203.0.113.9');
  });

  it('IPv6 в скобках с портом → чистый адрес', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-forwarded-for': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
  });

  it('IPv6 без скобок проходит как есть (в нижнем регистре)', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-forwarded-for': '2001:DB8::AB' }))).toBe('2001:db8::ab');
  });

  it('правый элемент — мусор → "unknown", БЕЗ добора левее (левое подконтрольно клиенту)', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9, _hidden' }))).toBe('unknown');
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9, unknown' }))).toBe('unknown');
  });

  it('пустой и мусорный XFF → "unknown"', async () => {
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-forwarded-for': '' }))).toBe('unknown');
    expect(getClientIp(reqWith({ 'x-forwarded-for': ' , , ' }))).toBe('unknown');
    expect(getClientIp(reqWith({ 'x-forwarded-for': '999.1.1.1' }))).toBe('unknown');
  });

  it('vercel-режим: x-real-ip с портом тоже нормализуется', async () => {
    process.env.CLIENT_IP_MODE = 'vercel';
    const { getClientIp } = await loadModule();
    expect(getClientIp(reqWith({ 'x-real-ip': '203.0.113.5:1234' }))).toBe('203.0.113.5');
  });

  it('vercel-режим: невалидный x-real-ip не становится ключом → падаем в XFF', async () => {
    process.env.CLIENT_IP_MODE = 'vercel';
    const { getClientIp } = await loadModule();
    const req = reqWith({ 'x-real-ip': 'spoof-1', 'x-forwarded-for': '198.51.100.7' });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('секрет прокси совпал, но X-Client-IP — мусор → не берём его ключом', async () => {
    process.env.PROXY_SHARED_SECRET = 'shared';
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-client-ip': 'not-an-ip',
      'x-proxy-secret': 'shared',
      'x-forwarded-for': '198.51.100.7',
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('прокси-секрет + traefik: валидный X-Client-IP приоритетнее XFF прокси', async () => {
    process.env.PROXY_SHARED_SECRET = 'shared';
    const { getClientIp } = await loadModule();
    const req = reqWith({
      'x-client-ip': '198.51.100.7', // реальный посетитель от Caddy
      'x-proxy-secret': 'shared',
      'x-forwarded-for': '104.171.133.70', // IP прокси, который видит Traefik
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });
});
