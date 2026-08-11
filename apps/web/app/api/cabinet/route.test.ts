import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';

const h = vi.hoisted(() => ({
  verify: vi.fn(() =>
    h.state.signatureOk
      ? {
          ok: true as const,
          identity: { telegramId: '379336096', user: { id: 379336096 }, startParam: null },
        }
      : { ok: false as const, status: h.state.signatureStatus, error: h.state.signatureReason },
  ),
  upsert: vi.fn(async () => ({
    ok: true as const,
    user: { userId: 'user-1', telegramId: '379336096', user: { id: 379336096 } },
  })),
  checkRateLimit: vi.fn(async (name: string) => ({
    allowed: name === 'cabinet-auth' ? h.state.authFloodAllowed : h.state.identityAllowed,
    configured: true,
    limit: 60,
    remaining: 0,
  })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  buildSnapshot: vi.fn(async () => ({ orders: [], cards: [] })),
  state: {
    signatureOk: true,
    signatureReason: 'bad_signature' as string,
    signatureStatus: 401,
    identityAllowed: true,
    authFloodAllowed: true,
  },
}));

vi.mock('@/lib/cabinet/auth', () => ({
  verifyCabinetInitData: h.verify,
  upsertCabinetUser: h.upsert,
}));
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: h.checkRateLimit,
  getClientIp: h.getClientIp,
}));
vi.mock('@/lib/cabinet/read', () => ({
  buildSnapshot: h.buildSnapshot,
  buildOrderDetail: vi.fn(async () => null),
}));
vi.mock('@/lib/cabinet/actions', () => ({
  markSubscriptionActivated: vi.fn(async () => ({ ok: true })),
  payOrder: vi.fn(async () => ({ ok: true })),
  proposeNewOrder: vi.fn(async () => ({ ok: true })),
  reportPaymentIssue: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/cabinet/referral-read', () => ({
  getReferralLinkForCabinet: vi.fn(async () => null),
}));
vi.mock('@/lib/cabinet/card-secrets', () => ({
  getCardSecretsForUser: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/telegram/bot', () => ({ getBotUsername: vi.fn(async () => 'oplatishkaa_bot') }));
vi.mock('@/lib/telegram/deep-links', () => ({ referralMiniAppShortName: () => null }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'REFERRAL_ENABLED' ? false : undefined) },
  ),
}));

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('https://example.com/api/cabinet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const snapshotBody = { action: 'snapshot', initData: 'x' };

/**
 * Инвариант 9 CLAUDE.md: ни одна запись в БД не должна опережать rate-limit.
 * У `/api/cabinet` (аудит 2026-08-10) её опережали ВСЕ: `resolveCabinetUser`
 * upsert'ил `users` и делал реферальный захват, а per-identity лимит стоял
 * после него. Плюс не было барьера для потока с невалидной подписью.
 */
describe('POST /api/cabinet — порядок барьеров', () => {
  beforeEach(() => {
    h.verify.mockClear();
    h.upsert.mockClear();
    h.checkRateLimit.mockClear();
    h.buildSnapshot.mockClear();
    h.state.signatureOk = true;
    h.state.signatureReason = 'bad_signature';
    h.state.signatureStatus = 401;
    h.state.identityAllowed = true;
    h.state.authFloodAllowed = true;
  });

  it('per-identity лимит проверяется ДО upsert пользователя', async () => {
    await POST(makeRequest(snapshotBody));
    expect(h.checkRateLimit).toHaveBeenCalledWith('cabinet', '379336096');
    expect(h.checkRateLimit.mock.invocationCallOrder[0]!).toBeLessThan(
      h.upsert.mock.invocationCallOrder[0]!,
    );
  });

  it('исчерпанный лимит идентичности не доходит до записи в БД', async () => {
    h.state.identityAllowed = false;
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(429);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.buildSnapshot).not.toHaveBeenCalled();
  });

  it('кабинет НЕ делит бакет с ботом', async () => {
    // Общий `telegram` означал бы: просмотр кабинета выедает лимит бота, и
    // наоборот — `/start link_` (шаг оплаты) блокируется листанием заказов.
    await POST(makeRequest(snapshotBody));
    const names = h.checkRateLimit.mock.calls.map((c) => c[0]);
    expect(names).not.toContain('telegram');
  });

  it('429 отдаётся в формате, который разбирает клиент кабинета', async () => {
    // `payResultSchema`/`orderCreationResultSchema` требуют `message` в ветке
    // ok:false; без него Mini App показывает «Сеть недоступна» и зовёт повторить.
    h.state.identityAllowed = false;
    const res = await POST(makeRequest({ action: 'pay', initData: 'x', orderId: crypto.randomUUID() }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { ok: boolean; error: string; message?: string };
    expect(body.error).toBe('rate_limited');
    expect(typeof body.message).toBe('string');
    expect(body.message).not.toHaveLength(0);
  });

  it('невалидная подпись не трогает ни БД, ни бакет идентичности', async () => {
    h.state.signatureOk = false;
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(401);
    expect(h.upsert).not.toHaveBeenCalled();
    const names = h.checkRateLimit.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['cabinet-auth']);
    expect(h.checkRateLimit).toHaveBeenCalledWith('cabinet-auth', '1.2.3.4');
  });

  it('поток невалидных подписей с одного IP упирается в 429', async () => {
    h.state.signatureOk = false;
    h.state.authFloodAllowed = false;
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(429);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('опознанный запрос IP-бакет отказов НЕ трогает', async () => {
    // Иначе за CGNAT и за собственным VPN (один egress на всех) чужой флуд
    // резал бы живых плательщиков.
    await POST(makeRequest(snapshotBody));
    const names = h.checkRateLimit.mock.calls.map((c) => c[0]);
    expect(names).not.toContain('cabinet-auth');
  });

  it('битое тело — 400, без проверки подписи и записей', async () => {
    const res = await POST(makeRequest({ action: 'nope' }));
    expect(res.status).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('поток битых тел тоже упирается в IP-бакет отказов', async () => {
    // Разбор тела идёт до проверки подписи, поэтому мусор был бы САМЫМ дешёвым
    // способом дёргать роут мимо любого барьера (ревью 2026-08-11).
    h.state.authFloodAllowed = false;
    const res = await POST(makeRequest({ action: 'nope' }));
    expect(res.status).toBe(429);
    expect(h.checkRateLimit).toHaveBeenCalledWith('cabinet-auth', '1.2.3.4');
  });

  it('протухшая подпись НЕ считается атакой и отдаёт свою причину', async () => {
    // `expired` — штатный конец жизни сессии. Подменять «открой кабинет заново
    // из бота» на «подожди минутку» бессмысленно, а за общим адресом (CGNAT,
    // наш же VPN) это накрыло бы сразу всех.
    h.state.signatureOk = false;
    h.state.signatureReason = 'expired';
    h.state.authFloodAllowed = false;
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'expired' });
    const names = h.checkRateLimit.mock.calls.map((c) => c[0]);
    expect(names).not.toContain('cabinet-auth');
  });

  it('наша авария конфига не прячется за 429', async () => {
    h.state.signatureOk = false;
    h.state.signatureReason = 'misconfigured';
    h.state.signatureStatus = 500;
    h.state.authFloodAllowed = false;
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'misconfigured' });
  });

  it('обычный запрос при свободных бакетах проходит', async () => {
    const res = await POST(makeRequest(snapshotBody));
    expect(res.status).toBe(200);
    expect(h.buildSnapshot).toHaveBeenCalledOnce();
  });
});
