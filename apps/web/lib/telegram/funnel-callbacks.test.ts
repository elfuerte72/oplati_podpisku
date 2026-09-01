import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelegramCallbackQuery } from '@oplati/types';

/**
 * Кнопки воронки `fb:*` (тикеты 03–05): запись ответа один раз, каскад
 * оценки, «Другое» → существующая дверь в поддержку, «Больше не напоминать».
 * Диспетчеризация (что `fb:` вообще доезжает сюда) — handle-update.funnel.test.ts.
 */

const h = vi.hoisted(() => ({
  env: {
    REVIEWS_CHAT_URL: undefined as string | undefined,
    APP_URL: 'https://example.com',
  },
  state: {
    ctx: { userId: 'u1', conversationId: 'c1' } as { userId: string; conversationId: string } | null,
    recordResult: true,
    order: { id: 'o1', userId: 'u1', shortId: 'ORD-1', status: 'completed' } as
      | { id: string; userId: string; shortId: string; status: string }
      | null,
  },
  sendMock: vi.fn(async (..._args: unknown[]) => true),
  recordMock: vi.fn(async (..._args: unknown[]) => h.state.recordResult),
  optOutMock: vi.fn(async (..._args: unknown[]) => undefined),
  supportEntryMock: vi.fn(async (..._args: unknown[]) => undefined),
  notifyStaffMock: vi.fn(async (..._args: unknown[]) => ({ delivered: 1, failed: 0, deduped: false })),
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/alerts/notify-staff', () => ({ notifyStaff: h.notifyStaffMock }));
vi.mock('./persist', () => ({ resolveCallbackContext: vi.fn(async () => h.state.ctx) }));
vi.mock('./send', () => ({ sendSafely: h.sendMock }));
vi.mock('./support-entry', () => ({ openSupportEntry: h.supportEntryMock }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  recordClientFeedback: h.recordMock,
  setFunnelOptOut: h.optOutMock,
  getOrderById: vi.fn(async () => h.state.order),
}));

import { handleFunnelCallback } from './funnel-callbacks.ts';
import {
  FUNNEL_OPTOUT_DONE_TEXT,
  FUNNEL_THANKS_TEXT,
  RATING_HIGH_TEXT,
  RATING_HIGH_TEXT_NO_LINK,
  RATING_LOW_TEXT,
} from './templates.ts';

const cb = { id: 'cb1', from: { id: 42 } } as unknown as TelegramCallbackQuery;

// orderId в callback-data валидируется как UUID (подделываемый вход) —
// тестовые id обязаны быть настоящими uuid.
const OID = '11111111-1111-4111-8111-111111111111';
const OID2 = '22222222-2222-4222-8222-222222222222';

function callFb(data: string) {
  return handleFunnelCallback(cb, 42, data.split(':'), 1001);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.REVIEWS_CHAT_URL = undefined;
  h.state.ctx = { userId: 'u1', conversationId: 'c1' };
  h.state.recordResult = true;
  h.state.order = { id: OID, userId: 'u1', shortId: 'ORD-1', status: 'completed' };
});

describe('fb:optout', () => {
  it('пишет отписку и отвечает короткой репликой', async () => {
    await callFb('fb:optout');

    expect(h.optOutMock).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(h.sendMock).toHaveBeenCalledWith(42, FUNNEL_OPTOUT_DONE_TEXT, 1001);
  });
});

describe('fb:exp / fb:st — ответы опросов', () => {
  it('пишет ответ (kind + ключ) и благодарит; без суффикса — без связки с заказом', async () => {
    await callFb('fb:exp:price');

    expect(h.recordMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'expired_survey',
      orderId: null,
      answer: 'price',
    });
    expect(h.sendMock).toHaveBeenCalledWith(42, FUNNEL_THANKS_TEXT, 1001);
  });

  it('свой заказ в суффиксе привязывается к ответу; чужой/мусор — ответ без связки', async () => {
    await callFb(`fb:exp:price:${OID}`);
    expect(h.recordMock).toHaveBeenLastCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'expired_survey',
      orderId: OID,
      answer: 'price',
    });

    // Чужой заказ: ответ НЕ отбрасывается (он про клиента), связка — null.
    h.state.order = { id: OID, userId: 'someone-else', shortId: 'ORD-X', status: 'expired' };
    await callFb(`fb:exp:howto:${OID}`);
    expect(h.recordMock).toHaveBeenLastCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'expired_survey',
      orderId: null,
      answer: 'howto',
    });

    await callFb('fb:exp:changed:not-a-uuid');
    expect(h.recordMock).toHaveBeenLastCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'expired_survey',
      orderId: null,
      answer: 'changed',
    });
  });

  it('повторное нажатие не дублирует строку и молчит', async () => {
    h.state.recordResult = false;

    await callFb('fb:st:thinking');

    expect(h.recordMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('«Другое» ведёт в существующий support-флоу (правило В3)', async () => {
    await callFb('fb:exp:other');

    expect(h.recordMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'expired_survey',
      orderId: null,
      answer: 'other',
    });
    expect(h.supportEntryMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('неизвестный ключ отбрасывается без записи', async () => {
    await callFb('fb:exp:hacked');

    expect(h.recordMock).not.toHaveBeenCalled();
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('гонка тикета 04: заказ, созданный между выборкой и кликом, ничего не ломает', async () => {
    // Обработчик ответа опроса заказы не читает вовсе (getOrderById не
    // зовётся) — появившийся за это время заказ не влияет: ответ просто
    // записывается, как и обещает тикет.
    const db = await import('@oplati/db');

    await callFb('fb:st:noservice');

    expect(h.recordMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'start_survey',
      orderId: null,
      answer: 'noservice',
    });
    expect(vi.mocked(db.getOrderById)).not.toHaveBeenCalled();
    expect(h.sendMock).toHaveBeenCalledWith(42, FUNNEL_THANKS_TEXT, 1001);
  });
});

describe('fb:rate — оценка и каскад', () => {
  it('4–5 с настроенным чатом отзывов → приглашение с url-кнопкой, без DM персоналу', async () => {
    h.env.REVIEWS_CHAT_URL = 'https://t.me/oplatishka1';

    await callFb(`fb:rate:5:${OID}`);

    expect(h.recordMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'order_rating',
      orderId: OID,
      score: 5,
    });
    expect(h.sendMock).toHaveBeenCalledTimes(1);
    const [chatId, text, , keyboard] = h.sendMock.mock.calls[0]! as [
      number,
      string,
      number,
      { inline_keyboard: { url?: string }[][] },
    ];
    expect(chatId).toBe(42);
    expect(text).toBe(RATING_HIGH_TEXT);
    expect(keyboard.inline_keyboard.flat()[0]?.url).toBe('https://t.me/oplatishka1');
    expect(h.notifyStaffMock).not.toHaveBeenCalled();
  });

  it('4–5 без чата отзывов → благодарность без ссылки', async () => {
    await callFb(`fb:rate:4:${OID}`);
    expect(h.sendMock).toHaveBeenCalledWith(42, RATING_HIGH_TEXT_NO_LINK, 1001);
  });

  it('1–3 → клиенту дверь в поддержку ПЕРВОЙ, потом ровно один DM персоналу', async () => {
    await callFb(`fb:rate:2:${OID}`);

    expect(h.sendMock).toHaveBeenCalledTimes(1);
    const [, text] = h.sendMock.mock.calls[0]! as [number, string];
    expect(text).toBe(RATING_LOW_TEXT);

    expect(h.notifyStaffMock).toHaveBeenCalledTimes(1);
    const [alertText, opts] = h.notifyStaffMock.mock.calls[0]! as [
      string,
      { capability: string; dedupKey: string },
    ];
    expect(alertText).toContain('2/5');
    expect(alertText).toContain('ORD-1');
    expect(opts.capability).toBe('support');

    // Клиенту — первым (приоритет доставки клиенту).
    expect(h.sendMock.mock.invocationCallOrder[0]!).toBeLessThan(
      h.notifyStaffMock.mock.invocationCallOrder[0]!,
    );
  });

  it('двойной клик по звезде: вторая запись не вставилась → ни каскада, ни второго DM', async () => {
    h.state.recordResult = false;

    await callFb(`fb:rate:1:${OID}`);

    expect(h.sendMock).not.toHaveBeenCalled();
    expect(h.notifyStaffMock).not.toHaveBeenCalled();
  });

  it('чужой или несуществующий заказ в callback-data → оценка не пишется', async () => {
    h.state.order = { id: OID, userId: 'someone-else', shortId: 'ORD-X', status: 'completed' };
    await callFb(`fb:rate:5:${OID}`);
    expect(h.recordMock).not.toHaveBeenCalled();

    h.state.order = null;
    await callFb(`fb:rate:5:${OID2}`);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it('свой, но НЕ completed заказ → оценка не пишется и DM не уходит (форж по черновику)', async () => {
    h.state.order = { id: OID, userId: 'u1', shortId: 'ORD-1', status: 'expired' };

    await callFb(`fb:rate:1:${OID}`);

    expect(h.recordMock).not.toHaveBeenCalled();
    expect(h.notifyStaffMock).not.toHaveBeenCalled();
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('score вне 1..5 и мусор в данных отбрасываются', async () => {
    await callFb(`fb:rate:9:${OID}`);
    await callFb(`fb:rate:x:${OID}`);
    await callFb('fb:rate:5');
    // Не-UUID отсекается ДО запроса в БД: иначе поддельная кнопка роняла бы
    // «invalid input syntax» в Sentry на каждый клик.
    await callFb('fb:rate:5:not-a-uuid');
    expect(h.recordMock).not.toHaveBeenCalled();
  });
});

describe('деградация', () => {
  it('БД недоступна (нет контекста) → тихий выход без ответа', async () => {
    h.state.ctx = null;
    await callFb('fb:optout');
    expect(h.optOutMock).not.toHaveBeenCalled();
    expect(h.sendMock).not.toHaveBeenCalled();
  });
});
