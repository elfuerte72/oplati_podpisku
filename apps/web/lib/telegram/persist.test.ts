import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `persistInbound` — единственный источник `userCreated` для `/start ref_`:
 * по нему бот решает, что новому другу реферер уже проставлен INSERT'ом и пора
 * сказать об этом ему и партнёру. Тесты `start-menu` мокают persist целиком,
 * поэтому потерю поля они бы не заметили (ревью PR #200): новый друг молча
 * уходил бы в поздний захват → `already_set` → тишина — ровно тот баг, который
 * PR чинит.
 */

const h = vi.hoisted(() => ({
  getOrCreateUserByTelegramId: vi.fn(),
  getOrCreateActiveConversation: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  appendMessage: vi.fn(),
  getLastAssistantMessageMeta: vi.fn(),
  getOrCreateUserByTelegramId: h.getOrCreateUserByTelegramId,
  getOrCreateActiveConversation: h.getOrCreateActiveConversation,
}));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('./templates', () => ({ redactCardNumbers: (s: string) => s }));

import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { persistInbound } from './persist.ts';

const message = {
  message_id: 5,
  date: 0,
  chat: { id: 100, type: 'private' },
  from: { id: 100, is_bot: false, first_name: 'Друг', language_code: 'ru' },
  text: '/start ref_abc12345',
} as unknown as TelegramMessage;
const update = { update_id: 1, message } as unknown as TelegramUpdate;

describe('persistInbound — userCreated и referredBy', () => {
  beforeEach(() => {
    h.getOrCreateUserByTelegramId.mockReset().mockResolvedValue({ id: 'u1', created: true });
    h.getOrCreateActiveConversation.mockReset().mockResolvedValue({ id: 'c1', created: true });
  });

  it('новая строка → userCreated: true, реферер уходит в upsert', async () => {
    await expect(persistInbound(update, message, { referredBy: 'partner-1' })).resolves.toEqual({
      userId: 'u1',
      conversationId: 'c1',
      userCreated: true,
    });
    expect(h.getOrCreateUserByTelegramId).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ telegramId: '100', referredBy: 'partner-1', language: 'ru' }),
      expect.anything(),
    );
  });

  it('существующая строка → userCreated: false; без opts реферер = null', async () => {
    h.getOrCreateUserByTelegramId.mockResolvedValue({ id: 'u1', created: false });
    await expect(persistInbound(update, message)).resolves.toMatchObject({ userCreated: false });
    expect(h.getOrCreateUserByTelegramId.mock.calls[0]?.[1]).toMatchObject({ referredBy: null });
  });

  it('сбой БД на разговоре → null, ошибка не пробрасывается', async () => {
    h.getOrCreateActiveConversation.mockRejectedValue(new Error('db down'));
    await expect(persistInbound(update, message, { referredBy: 'partner-1' })).resolves.toBeNull();
  });

  it('апдейт без from.id → null без запросов', async () => {
    const anon = { ...message, from: undefined } as unknown as TelegramMessage;
    await expect(persistInbound(update, anon)).resolves.toBeNull();
    expect(h.getOrCreateUserByTelegramId).not.toHaveBeenCalled();
  });
});
