import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TELEGRAM_BOT_TOKEN = '7777777:test-token';

const h = vi.hoisted(() => ({
  sendSafely: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../telegram/send.ts', () => ({ sendSafely: h.sendSafely }));
vi.mock('@/lib/dedup', () => ({ claimOnce: vi.fn(async () => true), releaseClaim: vi.fn(async () => undefined) }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'TELEGRAM_BOT_TOKEN' ? '7777777:test-token' : undefined) },
  ),
}));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CABINET_SUPPORT_HANDOFF_TEXT } from '../telegram/templates.ts';
import { sendCabinetSupportHandoff } from './support-handoff.ts';

/**
 * «Написать в поддержку» в Mini App: бот присылает в чат кнопку «Поддержка».
 * Кнопка обязана вести на ТОТ ЖЕ callback `support`, что в меню `/start` и
 * под подсказкой: второй вход в поддержку означал бы второй флоу обращений,
 * который панель и крон не видят (правило В3).
 */
describe('sendCabinetSupportHandoff', () => {
  beforeEach(() => {
    h.sendSafely.mockClear();
    h.sendSafely.mockResolvedValue(true);
  });

  it('шлёт клиенту в чат текст и кнопку на callback support', async () => {
    const delivered = await sendCabinetSupportHandoff('379336096');

    expect(delivered).toBe(true);
    expect(h.sendSafely).toHaveBeenCalledOnce();
    const [chatId, text, , keyboard] = h.sendSafely.mock.calls[0] ?? [];
    expect(chatId).toBe(379336096);
    expect(text).toBe(CABINET_SUPPORT_HANDOFF_TEXT);
    const buttons = (keyboard as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(['support']);
  });

  it('не доставлено (клиент заблокировал бота, сбой Telegram) — false', async () => {
    h.sendSafely.mockResolvedValueOnce(false);
    expect(await sendCabinetSupportHandoff('379336096')).toBe(false);
  });
});
