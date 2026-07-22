import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

async function loadModule() {
  return await import('./deployment-url.ts');
}

describe('deploymentBaseUrl / miniAppUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.APP_URL = 'https://www.oplatishka.com';
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.MINIAPP_BASE_URL;
  });

  afterEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.MINIAPP_BASE_URL;
    vi.resetModules();
  });

  it('production: siteUrl = APP_URL (за прокси, для РФ без VPN)', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL = 'ignored-hash.vercel.app';
    const { siteUrl } = await loadModule();
    expect(siteUrl()).toBe('https://www.oplatishka.com');
  });

  it('production: miniAppUrl ведёт на MINIAPP_BASE_URL напрямую (мимо прокси)', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.MINIAPP_BASE_URL = 'https://oplati-podpisku-web.vercel.app';
    const { miniAppUrl } = await loadModule();
    expect(miniAppUrl()).toBe('https://oplati-podpisku-web.vercel.app/cabinet');
  });

  it('production без MINIAPP_BASE_URL: miniAppUrl откатывается на APP_URL (как было)', async () => {
    process.env.VERCEL_ENV = 'production';
    const { miniAppUrl } = await loadModule();
    expect(miniAppUrl()).toBe('https://www.oplatishka.com/cabinet');
  });

  it('production: MINIAPP_BASE_URL не влияет на siteUrl (сайт остаётся за прокси)', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.MINIAPP_BASE_URL = 'https://oplati-podpisku-web.vercel.app';
    const { siteUrl, miniAppUrl } = await loadModule();
    expect(siteUrl()).toBe('https://www.oplatishka.com');
    expect(miniAppUrl()).toBe('https://oplati-podpisku-web.vercel.app/cabinet');
  });

  it('preview: miniAppUrl использует свой VERCEL_URL, MINIAPP_BASE_URL игнорируется', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = 'branch-preview.vercel.app';
    process.env.MINIAPP_BASE_URL = 'https://oplati-podpisku-web.vercel.app';
    const { miniAppUrl } = await loadModule();
    expect(miniAppUrl()).toBe('https://branch-preview.vercel.app/cabinet');
  });

  it('трейлинг-слэш в MINIAPP_BASE_URL срезается', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.MINIAPP_BASE_URL = 'https://oplati-podpisku-web.vercel.app/';
    const { miniAppUrl } = await loadModule();
    expect(miniAppUrl()).toBe('https://oplati-podpisku-web.vercel.app/cabinet');
  });
});
