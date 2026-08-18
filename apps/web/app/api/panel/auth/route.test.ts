import { createHash, createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Роуты входа в панель.
 *
 * Что здесь держится (и чего не видно из юнит-тестов ядра в `lib/panel`):
 *   - счётчик НЕУДАЧНЫХ попыток по IP и блокировка ДО проверки кода. Без
 *     второго перебор шестизначного кода не останавливался бы: учёт только
 *     промахов означает, что успешная попытка проходит мимо лимитера вовсе;
 *   - первый фактор кладёт ПРОМЕЖУТОЧНЫЙ токен, а не сессию;
 *   - между факторами доступ не выдаётся.
 */

const BOT_TOKEN = '7992756364:AAH-staff-bot';
const SESSION_SECRET = 'z'.repeat(64);

const h = vi.hoisted(() => ({
  isRateLimitDisabled: vi.fn(() => false),
  checkRateLimit: vi.fn(async (_name: string, _identity: string) => ({
    allowed: true,
    configured: true,
  })),
  peekRateLimit: vi.fn(async () => ({ allowed: true })),
  cookieStore: new Map<string, string>(),
  findStaffByTelegramId: vi.fn(),
  findStaffById: vi.fn(),
  startStaffTotpEnrollment: vi.fn(async (_db: unknown, _input: { secret: string }) => true),
  confirmStaffTotp: vi.fn(
    async (_db: unknown, _i: { staffId: string; expectedSecret: string }, _log?: unknown) => true,
  ),
  claimStaffTotpStep: vi.fn(
    async (_db: unknown, _i: { staffId: string; step: number }, _log?: unknown) => true,
  ),
  touchStaffLastLogin: vi.fn(async () => undefined),
  claimOnce: vi.fn(async (_key: string, _ttl?: number) => true),
}));

vi.mock('@/lib/dedup', () => ({ claimOnce: h.claimOnce }));

vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: h.checkRateLimit,
  peekRateLimit: h.peekRateLimit,
  getClientIp: () => '203.0.113.9',
  isRateLimitDisabled: h.isRateLimitDisabled,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'TELEGRAM_LOGIN_BOT_TOKEN') return BOT_TOKEN;
        if (prop === 'ADMIN_SESSION_SECRET') return SESSION_SECRET;
        return undefined;
      },
    },
  ),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findStaffByTelegramId: h.findStaffByTelegramId,
  findStaffById: h.findStaffById,
  startStaffTotpEnrollment: h.startStaffTotpEnrollment,
  confirmStaffTotp: h.confirmStaffTotp,
  claimStaffTotpStep: h.claimStaffTotpStep,
  touchStaffLastLogin: h.touchStaffLastLogin,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = h.cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
    // ⚠️ Двойник обязан вести себя как БРАУЗЕР: cookie гасится перезаписью с
    // истёкшим сроком, а не вызовом `delete`. Прежний двойник (`delete`
    // удаляет ключ) показывал рабочий выход там, где на проде он был no-op:
    // `delete` шлёт `Set-Cookie` без `Secure`, а имя с префиксом `__Host-`
    // браузер в таком виде отвергает целиком.
    set: (name: string, value: string, options?: { expires?: Date; maxAge?: number }) => {
      const expired =
        (options?.expires !== undefined && options.expires.getTime() <= Date.now()) ||
        options?.maxAge === 0;
      if (expired) h.cookieStore.delete(name);
      else h.cookieStore.set(name, value);
    },
    delete: (name: string) => {
      h.cookieStore.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

import { PANEL_PENDING_COOKIE, PANEL_SESSION_COOKIE } from '@/lib/panel/session';
import { verifyPanelToken } from '@/lib/panel/token';
import { generateTotpSecret, totpCodeAt } from '@/lib/panel/totp';

import { GET as telegramGet } from './telegram/route.ts';
import { POST as totpPost } from './totp/route.ts';

const SECRET = generateTotpSecret();
const STAFF_ID = '00000000-0000-4000-8000-000000000042';

function staff(over: Record<string, unknown> = {}) {
  return {
    id: STAFF_ID,
    email: 'owner@example.com',
    displayName: 'Владелец',
    role: 'admin',
    telegramId: '379336096',
    isActive: true,
    totpSecret: SECRET,
    totpConfirmedAt: new Date('2026-08-17T00:00:00Z'),
    lastLoginAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

function widgetUrl(telegramId = '379336096'): string {
  const fields: Record<string, string> = {
    id: telegramId,
    first_name: 'Владелец',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return `https://admin.oplatishka.com/api/panel/auth/telegram?${params.toString()}`;
}

function totpRequest(code: string): Request {
  return new Request('https://admin.oplatishka.com/api/panel/auth/totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

beforeEach(() => {
  h.cookieStore.clear();
  h.checkRateLimit.mockClear();
  h.checkRateLimit.mockImplementation(async () => ({ allowed: true, configured: true }));
  h.peekRateLimit.mockClear();
  h.peekRateLimit.mockImplementation(async () => ({ allowed: true }));
  h.findStaffByTelegramId.mockReset();
  h.findStaffById.mockReset();
  h.confirmStaffTotp.mockClear();
  h.claimStaffTotpStep.mockClear();
  h.claimStaffTotpStep.mockImplementation(async () => true);
  h.claimOnce.mockClear();
  h.claimOnce.mockImplementation(async () => true);
  h.touchStaffLastLogin.mockClear();
  h.startStaffTotpEnrollment.mockClear();
  h.startStaffTotpEnrollment.mockImplementation(async () => true);
  h.findStaffByTelegramId.mockImplementation(async () => staff());
  h.findStaffById.mockImplementation(async () => staff());
});

describe('GET /api/panel/auth/telegram — первый фактор', () => {
  it('впускает на второй фактор, но НЕ выдаёт сессию', async () => {
    const res = await telegramGet(new Request(widgetUrl()));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login/code');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);

    const pending = h.cookieStore.get(PANEL_PENDING_COOKIE);
    expect(pending).toBeDefined();
    // Промежуточный токен не работает как сессия — это его главное свойство.
    expect(
      verifyPanelToken(pending!, SESSION_SECRET, { purpose: 'session' }),
    ).toMatchObject({ ok: false });
    expect(verifyPanelToken(pending!, SESSION_SECRET, { purpose: 'pending' })).toMatchObject({
      ok: true,
      staffId: STAFF_ID,
    });
  });

  it('неудачная попытка расходует лимит', async () => {
    h.findStaffByTelegramId.mockImplementation(async () => null);

    const res = await telegramGet(new Request(widgetUrl('999')));

    expect(res.headers.get('location')).toBe('/admin/login?e=denied');
    expect(h.checkRateLimit).toHaveBeenCalledWith('admin-auth', '203.0.113.9');
  });

  it('успешная попытка лимит не расходует', async () => {
    await telegramGet(new Request(widgetUrl()));

    expect(h.checkRateLimit).not.toHaveBeenCalled();
  });

  it('исчерпанный лимит закрывает вход ДО проверки подписи', async () => {
    h.peekRateLimit.mockImplementation(async () => ({ allowed: false }));

    const res = await telegramGet(new Request(widgetUrl()));

    expect(res.headers.get('location')).toBe('/admin/login?e=rate_limited');
    expect(h.findStaffByTelegramId).not.toHaveBeenCalled();
  });

  it('повторный переход по той же ссылке виджета не перевыдаёт секрет', async () => {
    const url = widgetUrl();
    const used = new Set<string>();
    h.claimOnce.mockImplementation(async (key: string) =>
      used.has(key) ? false : (used.add(key), true),
    );

    await telegramGet(new Request(url));
    h.startStaffTotpEnrollment.mockClear();
    const res = await telegramGet(new Request(url));

    expect(res.headers.get('location')).toBe('/admin/login?e=replayed');
    expect(h.startStaffTotpEnrollment).not.toHaveBeenCalled();
  });

  it('недоступная база даёт понятный отказ, а не 500', async () => {
    h.findStaffByTelegramId.mockImplementation(async () => {
      throw new Error('db down');
    });

    const res = await telegramGet(new Request(widgetUrl()));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?e=unavailable');
  });

  it('подделанная подпись до базы не доходит', async () => {
    const forged = `${widgetUrl()}&extra=1`;

    const res = await telegramGet(new Request(forged));

    expect(res.headers.get('location')).toBe('/admin/login?e=bad_signature');
    expect(h.findStaffByTelegramId).not.toHaveBeenCalled();
  });
});

describe('POST /api/panel/auth/totp — второй фактор', () => {
  async function passFirstFactor(): Promise<void> {
    await telegramGet(new Request(widgetUrl()));
  }

  it('верный код выдаёт сессию и гасит промежуточный токен', async () => {
    await passFirstFactor();

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    const session = h.cookieStore.get(PANEL_SESSION_COOKIE);
    expect(verifyPanelToken(session ?? '', SESSION_SECRET, { purpose: 'session' })).toMatchObject({
      ok: true,
      staffId: STAFF_ID,
    });
    expect(h.cookieStore.has(PANEL_PENDING_COOKIE)).toBe(false);
    expect(h.touchStaffLastLogin).toHaveBeenCalled();
  });

  it('неверный код не пускает и расходует лимит', async () => {
    await passFirstFactor();
    h.checkRateLimit.mockClear();

    const res = await totpPost(totpRequest('000000'));

    expect(res.headers.get('location')).toBe('/admin/login/code?e=bad_code');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
    expect(h.checkRateLimit).toHaveBeenCalledWith('admin-auth', '203.0.113.9');
  });

  it('чужой флуд с того же IP НЕ запирает опознанного сотрудника', async () => {
    // На шаге кода человек уже опознан подписанным `pending`-токеном, а адрес
    // за CGNAT (или за нашим же VPN) общий на всех: блокировка по IP здесь
    // означала бы отказ в обслуживании себе. Перебор режет счётчик по
    // сотруднику, и сменой адреса его не обойти.
    await passFirstFactor();
    h.peekRateLimit.mockImplementation(async () => ({ allowed: false }));

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(true);
  });

  it('НЕДОСТУПНЫЙ счётчик попыток закрывает вход, а не открывает', async () => {
    // Fail-CLOSED, в отличие от клиентских путей: счётчик — единственный барьер
    // перебора второго фактора, `pending` живёт 10 минут и переиспользуется.
    // Отказ Redis не должен дарить миллион попыток владельцу чужого Telegram.
    await passFirstFactor();
    h.checkRateLimit.mockImplementation(async () => ({ allowed: true, configured: false }));

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin/login/code?e=rate_limited');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
  });

  it('ОСОЗНАННО выключенный лимит (dev) вход не ломает', async () => {
    await passFirstFactor();
    h.checkRateLimit.mockImplementation(async () => ({ allowed: true, configured: false }));
    h.isRateLimitDisabled.mockImplementation(() => true);

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin');
  });

  it('без первого фактора код бесполезен', async () => {
    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin/login?e=restart');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
    expect(h.findStaffById).not.toHaveBeenCalled();
  });

  it('перебор режется ПО СОТРУДНИКУ и расходуется на КАЖДУЮ попытку', async () => {
    await passFirstFactor();
    h.checkRateLimit.mockClear();

    await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    // Успешная попытка тоже платит: при учёте одних промахов пачка
    // параллельных запросов успевает проверить тысячу кодов.
    expect(h.checkRateLimit).toHaveBeenCalledWith('admin-totp', STAFF_ID);
  });

  it('исчерпанный лимит СОТРУДНИКА не пускает даже с верным кодом', async () => {
    await passFirstFactor();
    h.checkRateLimit.mockImplementation(async (name: string) =>
      name === 'admin-totp'
        ? { allowed: false, configured: true }
        : { allowed: true, configured: true },
    );

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin/login/code?e=rate_limited');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
  });

  it('переигранный код не пускает', async () => {
    await passFirstFactor();
    h.claimStaffTotpStep.mockImplementation(async () => false);

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin/login/code?e=code_used');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
  });

  it('форма (не JSON) — боевой путь страницы входа', async () => {
    await passFirstFactor();
    const form = new URLSearchParams({ code: totpCodeAt(SECRET, Math.floor(Date.now() / 1000)) });

    const res = await totpPost(
      new Request('https://admin.oplatishka.com/api/panel/auth/totp', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
    );

    expect(res.headers.get('location')).toBe('/admin');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(true);
  });

  it('недоступная база даёт понятный отказ, а не 500', async () => {
    await passFirstFactor();
    h.findStaffById.mockImplementation(async () => {
      throw new Error('db down');
    });

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?e=unavailable');
  });

  it('сотрудника отключили между факторами — сессии нет', async () => {
    await passFirstFactor();
    h.findStaffById.mockImplementation(async () => staff({ isActive: false }));

    const res = await totpPost(totpRequest(totpCodeAt(SECRET, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin/login?e=denied');
    expect(h.cookieStore.has(PANEL_SESSION_COOKIE)).toBe(false);
    expect(h.cookieStore.has(PANEL_PENDING_COOKIE)).toBe(false);
  });

  it('первый вход подтверждает привязку', async () => {
    h.findStaffByTelegramId.mockImplementation(async () =>
      staff({ totpSecret: null, totpConfirmedAt: null }),
    );
    // Панель выдала новый секрет и записала его в базу.
    let issued = '';
    // Репозиторий зовётся как (db, input) — секрет во ВТОРОМ аргументе.
    h.startStaffTotpEnrollment.mockImplementation(async (_db, input) => {
      issued = input.secret;
      return true;
    });
    await passFirstFactor();
    h.findStaffById.mockImplementation(async () =>
      staff({ totpSecret: issued, totpConfirmedAt: null }),
    );

    const res = await totpPost(totpRequest(totpCodeAt(issued, Math.floor(Date.now() / 1000))));

    expect(res.headers.get('location')).toBe('/admin');
    // Репозиторий зовётся как (db, staffId, log) — сверяем именно сотрудника.
    expect(h.confirmStaffTotp.mock.calls[0]?.[1]?.staffId).toBe(STAFF_ID);
  });
});
