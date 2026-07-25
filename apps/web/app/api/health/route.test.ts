import { describe, expect, it } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger и пр.).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';

const { GET } = await import('./route.ts');

/**
 * На поле `startedAt` завязан шаг проверки в `.github/workflows/deploy.yml`: он ждёт
 * времени старта позже момента триггера, чтобы отличить выкаченный релиз от
 * «триггер принят, а сборка упала». Уберут или переименуют поле — деплой начнёт
 * падать по таймауту при исправном проде, поэтому контракт закреплён тестом.
 */
describe('GET /api/health', () => {
  it('отдаёт ok и валидный ISO-момент старта процесса', async () => {
    const body = await GET().json();

    expect(body.status).toBe('ok');
    expect(typeof body.startedAt).toBe('string');
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(new Date(body.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('startedAt стабилен между запросами, timestamp — нет', async () => {
    const first = await GET().json();
    const second = await GET().json();

    // Момент старта у одного процесса один: workflow сравнивает его с отметкой
    // времени, поэтому «плавающее» значение сделало бы проверку бессмысленной.
    expect(second.startedAt).toBe(first.startedAt);
    expect(typeof second.timestamp).toBe('string');
  });

  it('не раскрывает версию сборки — репозиторий публичный', async () => {
    const body = await GET().json();

    // git SHA дал бы точное соответствие «прод ↔ строки кода» и показал бы,
    // какие фиксы ещё не выкачены. Если поле однажды понадобится — закрывать
    // токеном, а не отдавать публично.
    expect(Object.keys(body).sort()).toEqual(['startedAt', 'status', 'timestamp']);
  });
});
