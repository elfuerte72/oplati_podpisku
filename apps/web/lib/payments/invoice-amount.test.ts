import { describe, expect, it } from 'vitest';

import { exportOrderRow } from '@/lib/panel/export';
import { buildPaymentReminderText } from '@/lib/panel/remind';

/**
 * Канарейка ДВУХ СУММ (трек referral-balance-spend, §10 спеки, тикет 06).
 *
 * `orders.amount_rub` — ПОЛНАЯ цена заказа: по ней сверяется чек и считается
 * гейт телефона. `payments.amount_rub` — то, что запрошено у шлюза: полная цена
 * минус списанные баллы. Спутать их местами — не падение, а тихое враньё о
 * деньгах в обе стороны:
 *
 *  - назвать клиенту полную цену там, где платёжная страница попросит меньше,
 *    — он решит, что счёт выставлен неверно, и напишет в поддержку;
 *  - назвать сумму счёта там, где нужна цена заказа, — и выручка в отчёте
 *    разойдётся с чеком, а колонка «Баллами, ₽» в выгрузке станет двойным
 *    вычетом при сложении.
 *
 * Проверяется НЕ реализация, а ЧИСЛА на выходе: тест переживает переписывание
 * внутренностей и падает ровно тогда, когда сумма подставлена не та.
 */

/** Целые рубли так, как их печатает код напоминания. */
const rub = (kopecks: number) => Math.round(kopecks / 100).toLocaleString('ru-RU');

/** Worked example спеки: заказ 2008 ₽, баллами 286 ₽, счёт 1722 ₽. */
const ORDER_KOPECKS = 200_800;
const DISCOUNT_KOPECKS = 28_600;
const INVOICE_KOPECKS = ORDER_KOPECKS - DISCOUNT_KOPECKS;

describe('напоминание об оплате называет сумму СЧЁТА', () => {
  it('в тексте стоит сумма счёта, а полной цены заказа в нём нет', () => {
    // Клиент платит по живой ссылке: назвать 2008 ₽ значит попросить больше,
    // чем попросит страница оплаты.
    const text = buildPaymentReminderText({
      shortId: 'ORD-WX7S4',
      amountRubKopecks: INVOICE_KOPECKS,
      paymentUrl: 'https://pay.example/inv-1',
      expiresAt: null,
      now: new Date('2026-09-10T10:00:00Z'),
    });

    // Разделитель разрядов берём у той же локали, что и код: в `ru-RU` это
    // НЕРАЗРЫВНЫЙ пробел, и литерал с обычным не совпал бы ни с чем.
    expect(text).toContain(rub(INVOICE_KOPECKS));
    expect(text).not.toContain(rub(ORDER_KOPECKS));
  });
});

describe('выгрузка заказов называет ПОЛНУЮ цену и погашение отдельно', () => {
  const row = exportOrderRow({
    id: 'o1',
    shortId: 'ORD-WX7S4',
    status: 'completed',
    amountRubKopecks: ORDER_KOPECKS,
    bonusDiscountKopecks: DISCOUNT_KOPECKS,
    createdAt: new Date('2026-09-02T14:34:00Z'),
    expiresAt: null,
    serviceName: 'Netflix',
    client: { id: 'u1', displayName: 'Алинка', telegramId: '77', email: 'a@b.c' },
    assignedOperatorName: null,
  });

  it('колонка «Сумма» — цена заказа, а НЕ сумма счёта', () => {
    // Сумма счёта здесь сделала бы двойной вычет: колонку «Баллами» рядом
    // складывают с «Суммой», а не вычитают из неё.
    expect(row[3]).toBe('2008,00');
  });

  it('колонка «Баллами» — ровно погашенное, и это не разность', () => {
    expect(row[4]).toBe('286,00');
    expect(row[4]).not.toBe('1722,00');
  });
});
