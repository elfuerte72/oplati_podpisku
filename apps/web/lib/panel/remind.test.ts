import { describe, expect, it } from 'vitest';

import {
  PAYMENT_REMINDER_COOLDOWN_MS,
  buildPaymentReminderText,
  remindBlockReason,
  remindGateInput,
} from './remind';

/**
 * Напоминание об оплате (тикет 07). Самая большая денежная потеря на сегодня:
 * из 138 просроченных заказов 97 никогда не дошли до счёта, ещё 41 счёт
 * получили и не оплатили.
 */

const NOW = new Date('2026-08-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const LIVE = {
  status: 'pending_payment' as const,
  hasTelegram: true,
  hasPaymentLink: true,
  invoiceExpiresAt: ahead(30 * 60_000),
  lastRemindedAt: null,
  now: NOW,
};

describe('remindBlockReason', () => {
  it('живой счёт достижимому клиенту — напоминать можно', () => {
    expect(remindBlockReason(LIVE)).toBeNull();
  });

  it('клиенту без Telegram кнопки нет', () => {
    // 47 клиентов из 103 без telegram_id: написать им нечем, и кнопка, которая
    // молча ничего не делает, хуже её отсутствия.
    expect(remindBlockReason({ ...LIVE, hasTelegram: false })).toBe('no_telegram');
  });

  it('черновик без счёта: напоминать нечем — ссылки не существует', () => {
    // `ready_for_payment` — это зафиксированная цена без выставленного счёта.
    // Кнопка НИЧЕГО не создаёт, поэтому отправлять здесь нечего.
    expect(remindBlockReason({ ...LIVE, status: 'ready_for_payment' })).toBe('no_invoice');
  });

  it('счёт без ссылки на оплату отправлять нечем', () => {
    expect(remindBlockReason({ ...LIVE, hasPaymentLink: false })).toBe('no_invoice');
  });

  it('протухший счёт: статус заказа ещё оплатимый, а ссылка уже мертва', () => {
    // Заказы хоронит крон раз в 15 минут, то есть окно расхождения реально.
    // Клиент по такой ссылке получил бы «счёт не найден».
    expect(remindBlockReason({ ...LIVE, invoiceExpiresAt: ago(60_000) })).toBe('invoice_expired');
  });

  it('срок ровно «сейчас» — уже поздно', () => {
    // Граница проверяется явно: `<=` против `<` иначе меняется незаметно.
    expect(remindBlockReason({ ...LIVE, invoiceExpiresAt: NOW })).toBe('invoice_expired');
  });

  it('срок счёта неизвестен — закрываемся, а не отправляем', () => {
    // Fail-closed: гейт заводился против мёртвой ссылки, а пустой срок значит
    // «мы не знаем». Отправить в таком состоянии — ровно то, чего он избегает.
    expect(remindBlockReason({ ...LIVE, invoiceExpiresAt: null })).toBe('invoice_expired');
  });

  it('второе напоминание за сутки — это спам', () => {
    expect(
      remindBlockReason({ ...LIVE, lastRemindedAt: ago(PAYMENT_REMINDER_COOLDOWN_MS - 60_000) }),
    ).toBe('too_soon');
  });

  it('через сутки напомнить снова можно', () => {
    expect(
      remindBlockReason({ ...LIVE, lastRemindedAt: ago(PAYMENT_REMINDER_COOLDOWN_MS + 1000) }),
    ).toBeNull();
  });

  it('ровно сутки — уже можно (граница включительно)', () => {
    expect(
      remindBlockReason({ ...LIVE, lastRemindedAt: ago(PAYMENT_REMINDER_COOLDOWN_MS) }),
    ).toBeNull();
  });

  it('недостижимость важнее протухшего счёта: сначала говорим о главном', () => {
    expect(
      remindBlockReason({ ...LIVE, hasTelegram: false, invoiceExpiresAt: ago(60_000) }),
    ).toBe('no_telegram');
  });
});

describe('remindGateInput', () => {
  it('экран и операция собирают вход ОДИНАКОВО', () => {
    // Две сборки «по месту» означали бы кнопку там, где сервер откажет.
    const order = {
      status: 'pending_payment' as const,
      client: { telegramId: '555' },
      invoice: { paymentUrl: 'https://pay.example/1', expiresAt: ahead(10 * 60_000) },
      lastRemindedAt: null,
    };

    expect(remindGateInput(order, NOW)).toEqual({
      status: 'pending_payment',
      hasTelegram: true,
      hasPaymentLink: true,
      invoiceExpiresAt: order.invoice.expiresAt,
      lastRemindedAt: null,
      now: NOW,
    });
  });

  it('заказ без счёта не выдаёт себя за заказ со счётом', () => {
    const input = remindGateInput(
      {
        status: 'ready_for_payment' as const,
        client: { telegramId: null },
        invoice: null,
        lastRemindedAt: null,
      },
      NOW,
    );

    expect(input.hasPaymentLink).toBe(false);
    expect(input.invoiceExpiresAt).toBeNull();
    expect(input.hasTelegram).toBe(false);
  });
});

describe('buildPaymentReminderText', () => {
  it('в сообщении есть номер заказа, сумма и ссылка', () => {
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: 1_168_000,
      paymentUrl: 'https://pay.freekassa.ru/form/1',
      expiresAt: ahead(40 * 60_000),
      now: NOW,
    });

    expect(text).toContain('ORD-J6TBP');
    expect(text).toContain('11 680'.replace(' ', ' '));
    expect(text).toContain('https://pay.freekassa.ru/form/1');
  });

  it('остаток срока считается в минутах, а не печатается временем', () => {
    // Часовой пояс клиента неизвестен: «до 14:20» половине читателей означало
    // бы неверный час.
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: 50_000,
      paymentUrl: 'https://pay.example/1',
      expiresAt: ahead(25 * 60_000),
      now: NOW,
    });

    expect(text).toContain('25 мин');
  });

  it('истёкший срок в текст не попадает вовсе', () => {
    // Отправлять такое напоминание нельзя (гейт выше), но текст не должен
    // обещать «действует ещё -5 мин», если его позовут в обход.
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: 50_000,
      paymentUrl: 'https://pay.example/1',
      expiresAt: ago(5 * 60_000),
      now: NOW,
    });

    expect(text).not.toContain('действует');
  });

  it('надбавка платёжной системы называется рядом с суммой', () => {
    // Без неё напоминание обещает 11 680 ₽ там, где страница оплаты попросит
    // около 12 381 ₽: у Freekassa надбавка покупателя 6%.
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: 1_168_000,
      paymentUrl: 'https://pay.example/1',
      expiresAt: null,
      feeNote: 'Важно: На странице оплаты — около 12 381 ₽: комиссия платёжной системы 6%',
      now: NOW,
    });

    expect(text).toContain('12 381');
    expect(text.indexOf('12 381')).toBeGreaterThan(text.indexOf('Сумма'));
  });

  it('шлюз без надбавки лишней строки не добавляет', () => {
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: 50_000,
      paymentUrl: 'https://pay.example/1',
      expiresAt: null,
      feeNote: null,
      now: NOW,
    });

    expect(text).not.toContain('комиссия');
  });

  it('заказ без суммы не притворяется нулевым', () => {
    const text = buildPaymentReminderText({
      shortId: 'ORD-J6TBP',
      amountRubKopecks: null,
      paymentUrl: 'https://pay.example/1',
      expiresAt: null,
      now: NOW,
    });

    expect(text).not.toContain('0 ₽');
    expect(text).toContain('https://pay.example/1');
  });
});
