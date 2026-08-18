import { describe, expect, it } from 'vitest';

import { isClientVisibleOrderEvent, isInternalOrderEvent } from './read';

/**
 * Что клиент видит в истории своего заказа.
 *
 * `order_events` — общая таблица трёх потребителей: выручка, админ-панель и
 * Mini App клиента. Про третьего забывают: новый служебный тип события без
 * ярлыка доезжал клиенту строкой «Событие» — с временем и без смысла, между
 * «Счёт выставлен» и «Платёж на проверке банка», то есть ровно там, где у
 * человека и так списаны деньги, а карты нет.
 */
describe('isClientVisibleOrderEvent', () => {
  it('вехи заказа клиент видит', () => {
    expect(isClientVisibleOrderEvent({ eventType: 'payment_invoice_created', toStatus: null })).toBe(
      true,
    );
    expect(isClientVisibleOrderEvent({ eventType: 'card_issued', toStatus: null })).toBe(true);
  });

  it('смена статуса видна даже без своего ярлыка — подпись берётся у статуса', () => {
    expect(isClientVisibleOrderEvent({ eventType: 'manual_fulfillment_started', toStatus: 'in_fulfillment' })).toBe(
      true,
    );
  });

  it('НАШИ служебные отметки клиенту не показываются', () => {
    // «Мы написали клиенту про холд» и «напоминание о продлении отправлено» —
    // записи о наших действиях. Клиент про них узнаёт из самого сообщения в
    // Telegram, а в истории заказа они только шумят.
    expect(
      isClientVisibleOrderEvent({ eventType: 'payment_review_client_notified', toStatus: null }),
    ).toBe(false);
    expect(isClientVisibleOrderEvent({ eventType: 'renewal_reminder_sent', toStatus: null })).toBe(
      false,
    );
    // Напоминание об оплате из панели (тикет 07) — та же природа: клиент
    // получил его сообщением в Telegram, в истории заказа ему место не нужно.
    expect(isClientVisibleOrderEvent({ eventType: 'payment_reminder_sent', toStatus: null })).toBe(
      false,
    );
  });

  it('денилист проверяется ПРЯМО, а не через фолбэк', () => {
    // Через `isClientVisibleOrderEvent` эти строки не проверяются: событие без
    // ярлыка скрыто и так. Стоит кому-то подписать его в общем словаре — и
    // клиент увидит наше внутреннее действие в истории заказа.
    expect(isInternalOrderEvent('payment_review_client_notified')).toBe(true);
    expect(isInternalOrderEvent('payment_reminder_sent')).toBe(true);
    expect(isInternalOrderEvent('renewal_reminder_sent')).toBe(true);
    expect(isInternalOrderEvent('payment_succeeded')).toBe(false);
  });

  it('незнакомое событие без статуса не показывается вовсе', () => {
    // Раньше такое доезжало клиенту как «Событие». Показать нечего — значит
    // не показываем: это честнее, чем строка-загадка в истории платежа.
    expect(isClientVisibleOrderEvent({ eventType: 'какой_то_новый_тип', toStatus: null })).toBe(
      false,
    );
  });
});
