import { describe, expect, it } from 'vitest';

import { parseToolCards } from './tool-cards';

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
  it('лишние поля в output не ломают карточку (passthrough — бэкенд эволюционирует)', () => {
    const cards = parseToolCards([
      {
        name: 'confirm_order',
        input: {},
        output: {
          paymentUrl: 'https://pay.example/2',
          expiresAt: '2026-06-11T00:00:00Z',
          somethingNew: { nested: true },
        },
        isError: false,
      },
    ]);
    expect(cards).toEqual([
      { type: 'payment', paymentUrl: 'https://pay.example/2', qrPayload: null, expiresAt: '2026-06-11T00:00:00Z' },
    ]);
  });

  it('без обязательного поля карточки нет: пустой заказ хуже отсутствующего', () => {
    const cards = parseToolCards([
      {
        name: 'propose_order',
        input: { serviceName: 'Claude' },
        // нет totalRubKopecks — рисовать кнопку оплаты не из чего
        output: { orderId: 'o1', shortId: 'ORD-1', expiresAt: '2026-06-11T00:00:00Z' },
        isError: false,
      },
    ]);
    expect(cards).toEqual([]);
  });

  it('кривые НЕобязательные поля дают дефолт, а не выбрасывают карточку', () => {
    const cards = parseToolCards([
      {
        name: 'propose_order',
        input: { serviceName: 'Claude' },
        output: {
          orderId: 'o1',
          shortId: 'ORD-1',
          totalRubKopecks: 210100,
          expiresAt: '2026-06-11T00:00:00Z',
          originalAmountUsdCents: 'нечисло',
          isCustom: 'нет',
          buyerFeePercent: null,
        },
        isError: false,
      },
    ]);
    expect(cards).toEqual([
      {
        type: 'order',
        orderId: 'o1',
        shortId: 'ORD-1',
        service: 'Claude',
        totalKopecks: 210100,
        usdCents: null,
        expiresAt: '2026-06-11T00:00:00Z',
        isCustom: false,
        buyerFeePercent: 0,
      },
    ]);
  });

  it('битый элемент каталога выбрасывается, остальные рисуются', () => {
    const cards = parseToolCards([
      {
        name: 'search_catalog',
        input: {},
        output: [
          { id: 's1', name: 'Claude', requiresKyc: false },
          { id: '', name: 'без id' },
          { id: 's2', name: 'Spotify', requiresKyc: 'да' },
          null,
        ],
        isError: false,
      },
    ]);
    expect(cards).toEqual([
      {
        type: 'catalog',
        items: [
          { id: 's1', name: 'Claude', requiresKyc: false },
          { id: 's2', name: 'Spotify', requiresKyc: false },
        ],
      },
    ]);
  });

  it('не массив на входе — пустой список, без исключения', () => {
    expect(parseToolCards(null)).toEqual([]);
    expect(parseToolCards('нет')).toEqual([]);
    expect(parseToolCards(undefined)).toEqual([]);
  });

  it('web_search карточек не даёт', () => {
    const cards = parseToolCards([
      { name: 'web_search', input: { query: 'цена claude' }, output: [{ url: 'x' }], isError: false },
    ]);
    expect(cards).toEqual([]);
  });
});
