import { describe, expect, it } from 'vitest';

import {
  MANUAL_FULFILLMENT_STARTED,
  canCompleteManualFulfillment,
  canStartManualFulfillment,
  isStartedManually,
} from './fulfillment';

/**
 * Правила ручной выдачи.
 *
 * ⚠️ Главное здесь — «выдал» доступен ТОЛЬКО заказу, который взяли в работу
 * руками. Статус `in_fulfillment` сам по себе этого не значит: в него уводит и
 * автомат (`issueCard` захватывает `paid → in_fulfillment` и уходит в PaySpace
 * на десятки секунд). Отметь такой заказ выданным — и он становится
 * `completed`, а упавший следом `markOrderFailed` не сможет перевести его в
 * `failed` (машина такого ребра не знает), ошибку проглотит Sentry, и клиент
 * останется без карты при списанных деньгах, с «Выполнен» в кабинете и
 * напоминанием о продлении через три недели.
 */

const T0 = new Date('2026-08-18T10:00:00Z');
const T1 = new Date('2026-08-18T10:05:00Z');
const T2 = new Date('2026-08-18T10:10:00Z');

describe('canStartManualFulfillment', () => {
  it('только провалившийся заказ с УСПЕШНЫМ платежом', () => {
    expect(canStartManualFulfillment('failed', true)).toBe(true);
    // `failed` — не синоним «деньги получены»: туда же попадают отвергнутый
    // счёт и недоплата.
    expect(canStartManualFulfillment('failed', false)).toBe(false);
    expect(canStartManualFulfillment('paid', true)).toBe(false);
  });
});

describe('isStartedManually', () => {
  it('заказ, взятый в работу оператором', () => {
    expect(
      isStartedManually([
        { eventType: 'payment_succeeded', toStatus: 'paid', createdAt: T0 },
        { eventType: MANUAL_FULFILLMENT_STARTED, toStatus: 'in_fulfillment', createdAt: T1 },
      ]),
    ).toBe(true);
  });

  it('заказ, который в эту секунду выпускает карту АВТОМАТ', () => {
    expect(
      isStartedManually([
        { eventType: 'payment_succeeded', toStatus: 'paid', createdAt: T0 },
        { eventType: 'fulfillment_started', toStatus: 'in_fulfillment', createdAt: T1 },
      ]),
    ).toBe(false);
  });

  it('смотрит на ПОСЛЕДНИЙ вход в статус, а не на первый', () => {
    // Заказ входит в `in_fulfillment` не один раз: автомат провалился, оператор
    // взял его руками. Первый вход тут соврал бы.
    expect(
      isStartedManually([
        { eventType: 'fulfillment_started', toStatus: 'in_fulfillment', createdAt: T0 },
        { eventType: 'issue_card_failed', toStatus: 'failed', createdAt: T1 },
        { eventType: MANUAL_FULFILLMENT_STARTED, toStatus: 'in_fulfillment', createdAt: T2 },
      ]),
    ).toBe(true);
  });

  it('порядок массива значения не имеет — считается ВРЕМЯ', () => {
    // Панель отдаёт события свежими вперёд в одном месте и старыми вперёд в
    // другом; правило про деньги не должно зависеть от того, кто как сортирует.
    expect(
      isStartedManually([
        { eventType: MANUAL_FULFILLMENT_STARTED, toStatus: 'in_fulfillment', createdAt: T2 },
        { eventType: 'fulfillment_started', toStatus: 'in_fulfillment', createdAt: T0 },
      ]),
    ).toBe(true);
  });

  it('входа в статус не было вовсе', () => {
    expect(isStartedManually([{ eventType: 'order_created', toStatus: 'draft', createdAt: T0 }])).toBe(
      false,
    );
    expect(isStartedManually([])).toBe(false);
  });
});

describe('canCompleteManualFulfillment', () => {
  it('«выдал» — только по заказу, взятому руками', () => {
    expect(canCompleteManualFulfillment('in_fulfillment', true)).toBe(true);
    // Автомат сейчас выпускает карту: отметка «выдал» уводит заказ в
    // терминальный `completed` из-под него.
    expect(canCompleteManualFulfillment('in_fulfillment', false)).toBe(false);
    expect(canCompleteManualFulfillment('paid', true)).toBe(false);
  });
});
