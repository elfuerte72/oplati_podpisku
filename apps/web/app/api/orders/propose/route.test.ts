import { beforeEach, describe, expect, it, vi } from 'vitest';

// Тест гейта rate-limit (находка security-аудита): без него аноним без cookie
// получал свежую сессию — и свежий суточный кап заказов — на каждый запрос.

const rl = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, configured: true, limit: 8, remaining: 7 })),
}));
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: rl.checkRateLimit,
  getClientIp: () => '203.0.113.7',
}));

vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const session = vi.hoisted(() => ({ getOrCreateWebSessionId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/chat/session', () => session);

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
  getOrCreateUserByWebSessionId: vi.fn(async () => ({ id: 'user-1' })),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
}));
vi.mock('@oplati/db', () => dbMock);

const propose = vi.hoisted(() => ({
  proposeFromCatalog: vi.fn(async () => ({ ok: true, card: { orderId: 'order-1' } })),
}));
vi.mock('@/lib/catalog/propose', () => propose);

import { POST } from './route.ts';

function makeRequest(body: unknown): Request {
  return new Request('https://example.test/api/orders/propose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/orders/propose — rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rl.checkRateLimit.mockResolvedValue({ allowed: true, configured: true, limit: 8, remaining: 7 });
  });

  it('лимит превышен → 429 ДО резолва сессии и записей в БД', async () => {
    rl.checkRateLimit.mockResolvedValue({ allowed: false, configured: true, limit: 8, remaining: 0 });

    const res = await POST(makeRequest({ slug: 'netflix' }));

    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('rate_limited');
    // Главное: никакой записи — ни user, ни conversation, ни заказа.
    expect(session.getOrCreateWebSessionId).not.toHaveBeenCalled();
    expect(dbMock.getOrCreateUserByWebSessionId).not.toHaveBeenCalled();
    expect(propose.proposeFromCatalog).not.toHaveBeenCalled();
  });

  it('лимит не превышен → запрос проходит до proposeFromCatalog', async () => {
    const res = await POST(makeRequest({ slug: 'netflix' }));

    expect(res.status).toBe(200);
    expect(rl.checkRateLimit).toHaveBeenCalledWith('web-order', '203.0.113.7');
    expect(propose.proposeFromCatalog).toHaveBeenCalledTimes(1);
  });
});
