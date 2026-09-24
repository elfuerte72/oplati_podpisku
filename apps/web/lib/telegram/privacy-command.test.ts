import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendSafely: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('./send.ts', () => ({ sendSafely: h.sendSafely }));
vi.mock('../deployment-url.ts', () => ({ siteUrl: () => 'https://www.oplatishka.com/' }));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handlePrivacyCommand, isPrivacyCommand, privacyCommandText } from './privacy-command.ts';

/**
 * `/privacy` — требование Telegram к ботам: политика доступна командой. До
 * 2026-09-24 команда уходила в общую подсказку, и из чата политику было не
 * найти.
 */
describe('isPrivacyCommand', () => {
  it('команда, с хвостом и с именем бота', () => {
    expect(isPrivacyCommand('/privacy')).toBe(true);
    expect(isPrivacyCommand('/privacy please')).toBe(true);
    expect(isPrivacyCommand('/privacy@oplatishkaa_bot')).toBe(true);
  });

  it('похожий текст — не команда', () => {
    expect(isPrivacyCommand('/privacypolicy')).toBe(false);
    expect(isPrivacyCommand('privacy')).toBe(false);
    expect(isPrivacyCommand('/start')).toBe(false);
  });
});

describe('handlePrivacyCommand', () => {
  beforeEach(() => h.sendSafely.mockClear());

  it('шлёт в чат ссылки на политику и соглашение сайта — без двойного слэша', async () => {
    await handlePrivacyCommand(379336096, 42);

    expect(h.sendSafely).toHaveBeenCalledOnce();
    const [chatId, text] = h.sendSafely.mock.calls[0] ?? [];
    expect(chatId).toBe(379336096);
    expect(text).toContain('https://www.oplatishka.com/privacy');
    expect(text).toContain('https://www.oplatishka.com/terms');
    expect(privacyCommandText()).not.toContain('.com//');
  });
});
