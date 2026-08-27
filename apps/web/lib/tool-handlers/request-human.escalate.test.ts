import { describe, expect, it, vi } from 'vitest';

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getOrderById: vi.fn(async () => null),
  hasRecentOrderEvent: vi.fn(async () => false),
}));
vi.mock('@oplati/db/schema', () => ({ orderEvents: {} }));

import { requestHuman } from './request-human';

/**
 * Продажный `request_human` на общем механизме эскалации (тикет 04).
 *
 * До этого команда никого не звала — писала строку в `order_events` и молчала.
 * Проверяем через мок обработчика: колбэк зовётся с причиной модели, его сбой
 * tool не роняет (модель не должна переспрашивать клиента про оператора,
 * которого он уже просил), без колбэка поведение прежнее.
 */
describe('requestHuman → общий механизм эскалации', () => {
  it('зовёт escalateToHuman с причиной модели и подтверждает заявку', async () => {
    const escalateToHuman = vi.fn(async () => undefined);

    const res = await requestHuman({
      orderId: null,
      reason: 'клиент просит человека',
      userId: 'u1',
      conversationId: 'c1',
      escalateToHuman,
    });

    expect(escalateToHuman).toHaveBeenCalledWith('клиент просит человека');
    expect(res.acknowledged).toBe(true);
  });

  it('сорвавшаяся передача tool НЕ роняет — заявка подтверждена всё равно', async () => {
    const escalateToHuman = vi.fn(async () => {
      throw new Error('БД недоступна');
    });

    const res = await requestHuman({
      orderId: null,
      reason: 'причина',
      userId: 'u1',
      conversationId: 'c1',
      escalateToHuman,
    });

    expect(res.acknowledged).toBe(true);
  });

  it('без колбэка (веб-чат) — прежнее поведение, ничего не зовётся', async () => {
    const res = await requestHuman({ orderId: null, reason: 'причина', userId: 'u1', conversationId: 'c1' });
    expect(res).toMatchObject({ acknowledged: true, slaHours: 1 });
  });
});
