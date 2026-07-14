import { beforeEach, describe, expect, it, vi } from 'vitest';

// Переключаемый env: обе ссылки зависят от TELEGRAM_MINIAPP_SHORTNAME, но
// реф-ссылка — ещё и от отдельного флага REFERRAL_MINIAPP_DEEPLINK.
const hoisted = vi.hoisted(() => ({
  env: {
    TELEGRAM_MINIAPP_SHORTNAME: undefined as string | undefined,
    REFERRAL_MINIAPP_DEEPLINK: false,
  },
}));
vi.mock('@/lib/env', () => ({ serverEnv: hoisted.env }));
vi.mock('server-only', () => ({}));

const { cabinetDeepLink, referralMiniAppShortName } = await import('./deep-links');

describe('cabinetDeepLink', () => {
  beforeEach(() => {
    hoisted.env.TELEGRAM_MINIAPP_SHORTNAME = undefined;
    hoisted.env.REFERRAL_MINIAPP_DEEPLINK = false;
  });

  it('short name задан → прямая ссылка на Mini App (кабинет одним тапом)', () => {
    hoisted.env.TELEGRAM_MINIAPP_SHORTNAME = 'oplatishkaMiniApp';
    expect(cabinetDeepLink('oplatishkaa_bot')).toBe(
      'https://telegram.me/oplatishkaa_bot/oplatishkaMiniApp',
    );
  });

  it('short name не задан → deep-link на бота (там web_app-кнопка)', () => {
    expect(cabinetDeepLink('dev_test_podpiska_bot')).toBe(
      'https://telegram.me/dev_test_podpiska_bot?start=cabinet',
    );
  });
});

describe('referralMiniAppShortName', () => {
  beforeEach(() => {
    hoisted.env.TELEGRAM_MINIAPP_SHORTNAME = undefined;
    hoisted.env.REFERRAL_MINIAPP_DEEPLINK = false;
  });

  it('short name задан, флаг выключен → null (реф-ссылка остаётся bot-deep-link)', () => {
    hoisted.env.TELEGRAM_MINIAPP_SHORTNAME = 'oplatishkaMiniApp';
    expect(referralMiniAppShortName()).toBeNull();
  });

  it('флаг включён → отдаёт short name (реф-ссылка через startapp)', () => {
    hoisted.env.TELEGRAM_MINIAPP_SHORTNAME = 'oplatishkaMiniApp';
    hoisted.env.REFERRAL_MINIAPP_DEEPLINK = true;
    expect(referralMiniAppShortName()).toBe('oplatishkaMiniApp');
  });

  it('флаг включён, но short name не задан → null', () => {
    hoisted.env.REFERRAL_MINIAPP_DEEPLINK = true;
    expect(referralMiniAppShortName()).toBeNull();
  });
});
