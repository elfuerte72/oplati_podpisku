import { describe, expect, it } from 'vitest';

import {
  cardStatusLabel,
  formatAge,
  formatKopecks,
  formatOriginalAmount,
  formatUsdCents,
  paymentStatusLabel,
  priceBreakdown,
  orderStatusLabel,
  orderStatusTone,
  providerStatusLabel,
} from './format';
import { ORDER_STATUS_LABELS } from './labels';

describe('formatKopecks', () => {
  // Разделитель тысяч у ru-RU — НЕразрывный пробел (U+00A0): в плотной таблице
  // он держит сумму одной строкой. Пишем его явно, иначе тест ловит невидимую
  // разницу и выглядит сломанным без причины.
  const NBSP = '\u00A0';

  it('копейки превращаются в целые рубли', () => {
    expect(formatKopecks(123400)).toBe(`1${NBSP}234 ₽`);
  });

  it('округляет, а не отбрасывает — иначе сумма в панели не сойдётся с чеком', () => {
    expect(formatKopecks(123456)).toBe(`1${NBSP}235 ₽`);
    expect(formatKopecks(99)).toBe('1 ₽');
  });

  it('ноль — это ноль, а не прочерк', () => {
    expect(formatKopecks(0)).toBe('0 ₽');
  });

  it('пусто — прочерк', () => {
    expect(formatKopecks(null)).toBe('—');
    expect(formatKopecks(undefined)).toBe('—');
  });
});

describe('formatUsdCents', () => {
  it('центы показываются полностью — баланс карты копеечный по природе', () => {
    expect(formatUsdCents(1500)).toBe('$15.00');
    expect(formatUsdCents(8950)).toBe('$89.50');
    expect(formatUsdCents(0)).toBe('$0.00');
  });
});

describe('formatAge', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('минуты, часы и дни', () => {
    expect(formatAge(ago(5 * 60_000), now)).toBe('5 мин');
    expect(formatAge(ago(3 * 3_600_000), now)).toBe('3 ч');
    expect(formatAge(ago(3 * 3_600_000 + 12 * 60_000), now)).toBe('3 ч 12 мин');
    expect(formatAge(ago(50 * 3_600_000), now)).toBe('2 д 2 ч');
  });

  it('только что — не «0 мин»', () => {
    expect(formatAge(ago(20_000), now)).toBe('только что');
  });

  it('запись «из будущего» не даёт отрицательный возраст', () => {
    // Часы контейнера и базы расходятся; «-3 мин» в таблице выглядит поломкой.
    expect(formatAge(new Date(now.getTime() + 60_000), now)).toBe('только что');
  });
});

describe('подписи статусов', () => {
  it('известные статусы берутся из словаря панели', () => {
    // Сами слова закреплены в `labels.test.ts`; здесь — что функция читает
    // именно словарь, а не свою копию.
    expect(orderStatusLabel('payment_review')).toBe(ORDER_STATUS_LABELS.payment_review);
    expect(orderStatusLabel('pending_payment')).toBe('Ожидает оплаты');
  });

  it('незнакомый статус показывается как есть, а не роняет экран', () => {
    expect(orderStatusLabel('какой_то_новый')).toBe('какой_то_новый');
  });

  it('внимание требуют деньги в подвешенном состоянии', () => {
    expect(orderStatusTone('failed')).toBe('danger');
    expect(orderStatusTone('payment_review')).toBe('warn');
    expect(orderStatusTone('paid')).toBe('warn');
    expect(orderStatusTone('completed')).toBe('ok');
    expect(orderStatusTone('draft')).toBe('muted');
  });

  it('код холда антифрода подписан, и код остаётся рядом с текстом', () => {
    // Менеджер копирует код в обращение к Freekassa: «Проверка (7)» читается
    // словом, а число не теряется.
    expect(providerStatusLabel(7)).toBe('Проверка (7)');
    expect(providerStatusLabel(1)).toBe('Оплачен (1)');
  });

  it('неизвестный код показывается числом, а не прочерком', () => {
    expect(providerStatusLabel(42)).toBe('42');
    expect(providerStatusLabel(null)).toBe('—');
  });
});

describe('priceBreakdown', () => {
  const NBSP = '\u00A0';

  it('части сходятся с итогом', () => {
    const res = priceBreakdown(1_168_000, 32_000);

    expect(res.total).toBe(`11${NBSP}680 ₽`);
    expect(res.fee).toBe('320 ₽');
    expect(res.subscription).toBe(`11${NBSP}360 ₽`);
    expect(res.note).toBeNull();
  });

  it('копейки не разводят части с итогом', () => {
    // Округление каждой строки порознь давало расхождение на рубль, и чек
    // выглядел арифметически неверным.
    const res = priceBreakdown(100_050, 50_050);

    const toNumber = (v: string) => Number(v.replace(/[^\d]/g, ''));
    expect(toNumber(res.subscription) + toNumber(res.fee)).toBe(toNumber(res.total));
  });

  it('без надбавки строка выпуска — прочерк, а подписка равна итогу', () => {
    const res = priceBreakdown(50_000, 0);

    expect(res.fee).toBe('—');
    expect(res.subscription).toBe(res.total);
  });

  it('надбавка больше суммы — честная пометка вместо отрицательной подписки', () => {
    const res = priceBreakdown(10_000, 50_000);

    expect(res.subscription).toBe('—');
    expect(res.note).toContain('испорчен');
  });

  it('заказ без суммы не притворяется нулевым', () => {
    expect(priceBreakdown(null, null)).toMatchObject({ total: '—', subscription: '—' });
  });
});

describe('formatOriginalAmount', () => {
  it('валюта берётся из заказа, а не печатается долларом', () => {
    expect(formatOriginalAmount(1500, 'USD')).toBe('15.00 USD');
    expect(formatOriginalAmount(1500, 'EUR')).toBe('15.00 EUR');
  });

  it('без валюты — просто число, без выдуманного знака', () => {
    expect(formatOriginalAmount(1500, null)).toBe('15.00');
  });

  it('нет суммы — прочерк', () => {
    expect(formatOriginalAmount(null, 'USD')).toBe('—');
  });
});

describe('cardStatusLabel / paymentStatusLabel', () => {
  it('каждый статус карты подписан', () => {
    // `recycled` менеджеру не говорит ничего: это закрытая по сроку жизни
    // карта, а не сбой, и решение по заказу принимают по этой строке.
    expect(cardStatusLabel('active')).toBe('Активна');
    expect(cardStatusLabel('idle')).toBe('Простаивает');
    expect(cardStatusLabel('recycled')).toBe('Закрыта');
  });

  it('каждый статус платежа подписан', () => {
    expect(paymentStatusLabel('succeeded')).toBe('Оплачен');
    expect(paymentStatusLabel('failed')).toBe('Не прошёл');
    expect(paymentStatusLabel('refunded')).toBe('Возвращён');
  });

  it('«pending» на холде — «ожидает подтверждения», а не «ожидает оплаты»', () => {
    // При антифрод-холде деньги у клиента УЖЕ списаны, а строка платежа
    // остаётся pending: claim не проходил. «Ожидает оплаты» на экране проверки
    // платежей было бы прямой ложью ровно в том случае, ради которого экран и
    // заведён.
    expect(paymentStatusLabel('pending')).toBe('Ожидает подтверждения');
  });

  it('незнакомый статус показывается как есть, а не роняет страницу', () => {
    // Новое значение enum'а появляется в БД раньше, чем словарь панели.
    expect(cardStatusLabel('frozen')).toBe('frozen');
    expect(paymentStatusLabel('chargeback')).toBe('chargeback');
  });

  it('ключ прототипа не выдаётся за подпись', () => {
    // `dict['toString']` у объектного литерала вернул бы ФУНКЦИЮ там, где тип
    // обещает строку. Для enum'а базы это теория, но тот же приём словаря
    // используется для кода ошибки из тела ответа — там вход внешний.
    expect(cardStatusLabel('toString')).toBe('toString');
    expect(paymentStatusLabel('constructor')).toBe('constructor');
    expect(orderStatusLabel('hasOwnProperty')).toBe('hasOwnProperty');
  });
});
