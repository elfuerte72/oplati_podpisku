import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({
  alertSend: vi.fn(),
  prodSend: vi.fn(),
  alertCtor: vi.fn(),
}));

// grammY Bot: запоминаем, с каким токеном создан инстанс, и мокаем sendMessage.
vi.mock('grammy', () => ({
  Bot: class {
    api = { sendMessage: h.alertSend };
    constructor(token: string) {
      h.alertCtor(token);
    }
  },
}));

// Прод-бот (getBot) — отдельный мок, чтобы проверить fallback.
vi.mock('./bot.ts', () => ({
  getBot: () => ({ api: { sendMessage: h.prodSend } }),
}));

async function load() {
  return await import('./alert-bot.ts');
}

describe('sendAlert — отдельный alert-бот', () => {
  beforeEach(() => {
    vi.resetModules();
    h.alertSend.mockReset();
    h.prodSend.mockReset();
    h.alertCtor.mockReset();
    delete process.env.ALERT_BOT_TOKEN;
  });

  afterEach(() => {
    delete process.env.ALERT_BOT_TOKEN;
    vi.resetModules();
  });

  it('ALERT_BOT_TOKEN задан → шлёт через alert-бот, НЕ через прод-бот', async () => {
    process.env.ALERT_BOT_TOKEN = 'alert-bot-token';
    const { sendAlert } = await load();

    await sendAlert('379336096', 'squid лёг');

    expect(h.alertCtor).toHaveBeenCalledWith('alert-bot-token');
    expect(h.alertSend).toHaveBeenCalledWith('379336096', 'squid лёг');
    expect(h.prodSend).not.toHaveBeenCalled();
  });

  it('ALERT_BOT_TOKEN не задан → fallback на прод-бот (backward-compat)', async () => {
    const { sendAlert } = await load();

    await sendAlert('379336096', 'ошибка');

    expect(h.prodSend).toHaveBeenCalledWith('379336096', 'ошибка');
    expect(h.alertSend).not.toHaveBeenCalled();
  });

  it('alert-бот создаётся один раз (singleton) при повторных вызовах', async () => {
    process.env.ALERT_BOT_TOKEN = 'alert-bot-token';
    const { sendAlert } = await load();

    await sendAlert('1', 'a');
    await sendAlert('2', 'b');

    expect(h.alertCtor).toHaveBeenCalledTimes(1);
    expect(h.alertSend).toHaveBeenCalledTimes(2);
  });
});
