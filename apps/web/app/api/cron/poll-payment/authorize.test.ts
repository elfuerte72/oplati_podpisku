import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `authorizeCron` — один барьер на ВСЕ восемь cron-роутов (poll-payment,
 * expire-payments, recycle-cards, renewal-reminder, retention, keepalive,
 * referral-recovery, referral-rollup). За ним лежат закрытие карт, рассылки
 * клиентам и опрос платёжного шлюза наружу; до аудита 2026-08-10 он не был
 * покрыт ни одним тестом — включая fail-closed при незаданном `CRON_SECRET`.
 */

const h = vi.hoisted(() => ({
  env: {
    CRON_SECRET: 'cron-secret-value' as string | undefined,
    CRON_TOKEN: undefined as string | undefined,
    NODE_ENV: 'production' as string,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key],
  }),
}));

vi.mock('@/lib/jobs/poll-payment', () => ({ pollPayments: vi.fn(async () => ({ checked: 0 })) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { authorizeCron, GET } from './route.ts';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/cron/poll-payment', { headers });
}

beforeEach(() => {
  h.env.CRON_SECRET = 'cron-secret-value';
  h.env.CRON_TOKEN = undefined;
  h.env.NODE_ENV = 'production';
});

describe('authorizeCron — happy path', () => {
  it('Authorization: Bearer <secret> проходит', () => {
    expect(authorizeCron(req({ authorization: 'Bearer cron-secret-value' }))).toBe(true);
  });

  it('X-Cron-Token со значением секрета проходит (ручной вызов)', () => {
    expect(authorizeCron(req({ 'x-cron-token': 'cron-secret-value' }))).toBe(true);
  });

  it('CRON_TOKEN работает как запасное имя переменной', () => {
    h.env.CRON_SECRET = undefined;
    h.env.CRON_TOKEN = 'other-token';
    expect(authorizeCron(req({ authorization: 'Bearer other-token' }))).toBe(true);
  });

  it('CRON_SECRET имеет приоритет над CRON_TOKEN', () => {
    h.env.CRON_TOKEN = 'other-token';
    expect(authorizeCron(req({ authorization: 'Bearer other-token' }))).toBe(false);
    expect(authorizeCron(req({ authorization: 'Bearer cron-secret-value' }))).toBe(true);
  });
});

describe('authorizeCron — отказы', () => {
  it('без заголовков — отказ', () => {
    expect(authorizeCron(req())).toBe(false);
  });

  it('чужой секрет — отказ', () => {
    expect(authorizeCron(req({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(authorizeCron(req({ 'x-cron-token': 'wrong' }))).toBe(false);
  });

  it('схема Bearer обязательна: голый секрет в Authorization не проходит', () => {
    expect(authorizeCron(req({ authorization: 'cron-secret-value' }))).toBe(false);
  });

  it('префикс секрета не засчитывается за секрет', () => {
    expect(authorizeCron(req({ authorization: 'Bearer cron-secret-valu' }))).toBe(false);
    expect(authorizeCron(req({ authorization: 'Bearer cron-secret-value-extra' }))).toBe(false);
  });

  it('пустое значение заголовка не проходит', () => {
    expect(authorizeCron(req({ 'x-cron-token': '' }))).toBe(false);
  });
});

describe('authorizeCron — fail-closed при незаданном секрете', () => {
  it('на проде без секрета не пускает НИКОГО, даже без заголовков', () => {
    // Иначе публичный деплой (Deployment Protection выключен ради Telegram)
    // отдавал бы рециклинг карт и рассылки любому желающему.
    h.env.CRON_SECRET = undefined;
    h.env.CRON_TOKEN = undefined;
    expect(authorizeCron(req())).toBe(false);
    expect(authorizeCron(req({ authorization: 'Bearer anything' }))).toBe(false);
  });

  it('в NODE_ENV=development без секрета пускает (локальная разработка)', () => {
    h.env.CRON_SECRET = undefined;
    h.env.CRON_TOKEN = undefined;
    h.env.NODE_ENV = 'development';
    expect(authorizeCron(req())).toBe(true);
  });

  it('послабление действует ТОЛЬКО для development, не для test/preview', () => {
    h.env.CRON_SECRET = undefined;
    h.env.CRON_TOKEN = undefined;
    for (const env of ['test', 'preview', 'staging', '']) {
      h.env.NODE_ENV = env;
      expect(authorizeCron(req())).toBe(false);
    }
  });
});

describe('роут применяет барьер', () => {
  it('неавторизованный GET → 401 и джоб не запускается', async () => {
    const { pollPayments } = await import('@/lib/jobs/poll-payment');
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(pollPayments).not.toHaveBeenCalled();
  });

  it('авторизованный GET → 200 и джоб запускается', async () => {
    const res = await GET(req({ authorization: 'Bearer cron-secret-value' }));
    expect(res.status).toBe(200);
    const { pollPayments } = await import('@/lib/jobs/poll-payment');
    expect(pollPayments).toHaveBeenCalled();
  });
});
