import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Отметка «обращение подано» (тикет 10).
 *
 * Опечатка в ключе на стороне бота = ПУСТОЙ экран поддержки при живом потоке
 * обращений, без единого падения. Поэтому писателя проверяем прямо, а ключ
 * берётся из общего `@oplati/types` — читатель (панель) использует тот же.
 */

const h = vi.hoisted(() => ({
  persistInbound: vi.fn(),
  safeAppendMessage: vi.fn(async (..._args: unknown[]) => {}),
  readPendingMeta: vi.fn(async () => null as Record<string, unknown> | null),
  sendSafely: vi.fn(async () => {}),
  sendToSupportOperator: vi.fn(async () => true),
  trackServer: vi.fn(),
}));

vi.mock('./persist', () => ({
  persistInbound: h.persistInbound,
  safeAppendMessage: h.safeAppendMessage,
  readPendingMeta: h.readPendingMeta,
  resolveCallbackContext: vi.fn(),
}));

vi.mock('./send', () => ({ sendSafely: h.sendSafely }));
vi.mock('./support', () => ({ sendToSupportOperator: h.sendToSupportOperator }));
vi.mock('@/lib/analytics/track', () => ({ trackServer: h.trackServer }));

import { SUPPORT_DELIVERED_META_KEY, SUPPORT_REQUEST_META_KEY } from '@oplati/types';

import { tryHandlePendingSupport } from './support-flow';

const CTX = { conversationId: 'conv-1', userId: 'user-1' } as never;

function message() {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 555, type: 'private' as const },
    from: { id: 555, is_bot: false, first_name: 'Клиент' },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sendToSupportOperator.mockResolvedValue(true);
});

describe('tryHandlePendingSupport — отметка обращения', () => {
  it('поданное обращение помечается ключом, который читает панель', async () => {
    await tryHandlePendingSupport(
      CTX,
      message(),
      555,
      'не проходит оплата',
      { awaiting_support_message: true },
      1,
    );

    const meta = h.safeAppendMessage.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(meta[SUPPORT_REQUEST_META_KEY]).toBe(true);
    expect(meta[SUPPORT_DELIVERED_META_KEY]).toBe(true);
  });

  it('недоставленное оператору обращение помечается ЧЕСТНО', async () => {
    // Клиент считает, что написал; панель обязана показать, что не дошло.
    h.sendToSupportOperator.mockResolvedValue(false);

    await tryHandlePendingSupport(
      CTX,
      message(),
      555,
      'помогите',
      { awaiting_support_message: true },
      1,
    );

    const meta = h.safeAppendMessage.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(meta[SUPPORT_REQUEST_META_KEY]).toBe(true);
    expect(meta[SUPPORT_DELIVERED_META_KEY]).toBe(false);
  });

  it('без ожидания описания обращение не создаётся', async () => {
    // Правило владельца: обращение создаётся ТОЛЬКО нажатием кнопки или
    // командой, а не любым текстом.
    const handled = await tryHandlePendingSupport(CTX, message(), 555, 'привет', null, 1);

    expect(handled).toBe(false);
    expect(h.sendToSupportOperator).not.toHaveBeenCalled();
    expect(h.safeAppendMessage).not.toHaveBeenCalled();
  });
});
