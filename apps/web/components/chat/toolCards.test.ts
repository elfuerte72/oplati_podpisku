import { describe, expect, it } from 'vitest';

import { parseToolCards } from './toolCards';

/**
 * parseToolCards — клиентский парсер ToolCallLog[] в комикс-карточки.
 * Особый кейс: ошибка confirm_order с маркером telegram_link_required
 * (гейт привязки Telegram) должна давать карточку telegram_link,
 * любые другие ошибки tool'ов — пропускаться.
 */

describe('parseToolCards', () => {
  it('ошибка confirm_order с telegram_link_required даёт карточку telegram_link с orderId', () => {
    const cards = parseToolCards([
      {
        name: 'confirm_order',
        input: { orderId: 'a3e4b8d2-0000-4000-8000-000000000001' },
        output: {
          error:
            'telegram_link_required: у пользователя не привязан Telegram. Объясни это пользователю.',
        },
        isError: true,
      },
    ]);

    expect(cards).toEqual([
      { type: 'telegram_link', orderId: 'a3e4b8d2-0000-4000-8000-000000000001' },
    ]);
  });

  it('ошибка confirm_order без маркера привязки не даёт карточек', () => {
    const cards = parseToolCards([
      {
        name: 'confirm_order',
        input: { orderId: 'x' },
        output: { error: 'confirm_order: /api/payments/create вернул 500' },
        isError: true,
      },
    ]);
    expect(cards).toEqual([]);
  });

  it('ошибки прочих tool-ов пропускаются', () => {
    const cards = parseToolCards([
      { name: 'propose_order', input: {}, output: { error: 'telegram_link_required: нет' }, isError: true },
      { name: 'search_catalog', input: {}, output: { error: 'boom' }, isError: true },
    ]);
    expect(cards).toEqual([]);
  });

  it('успешный confirm_order по-прежнему даёт карточку payment', () => {
    const cards = parseToolCards([
      {
        name: 'confirm_order',
        input: { orderId: 'x' },
        output: { paymentUrl: 'https://pay.example/1', qrPayload: null, expiresAt: '2026-06-11T00:00:00Z' },
        isError: false,
      },
    ]);
    expect(cards).toEqual([
      { type: 'payment', paymentUrl: 'https://pay.example/1', qrPayload: null, expiresAt: '2026-06-11T00:00:00Z' },
    ]);
  });

  it('telegram_link без orderId во входе — orderId null', () => {
    const cards = parseToolCards([
      { name: 'confirm_order', input: null, output: { error: 'telegram_link_required: ...' }, isError: true },
    ]);
    expect(cards).toEqual([{ type: 'telegram_link', orderId: null }]);
  });
});
