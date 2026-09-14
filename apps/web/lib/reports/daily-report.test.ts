import { describe, expect, it } from 'vitest';

import type { DailyPaidOrder } from '@oplati/db';

import { formatKopecks } from '../panel/format.ts';

import {
  type DailyReportData,
  formatDailyReport,
  formatReportDate,
  mskDayRange,
  paidOrderLine,
  previousMskDay,
  resolveReportDay,
  TELEGRAM_MESSAGE_LIMIT,
} from './daily-report.ts';

/**
 * Дневной отчёт: окно и текст. Что держится:
 *   - отчёт — за КАЛЕНДАРНЫЙ день по Москве [00:00, 24:00), решение владельца
 *     2026-09-14 (скользящие сутки до 18:00 отвергнуты — не совпадают с днём панели);
 *   - крон утром (09:00 МСК) отчитывается за вчера, и время запуска на окно не влияет;
 *   - в списке оплат статус виден только у невыполненных заказов;
 *   - текст всегда влезает в одно сообщение Telegram и не врёт о числе оплат.
 */

const AT_CRON = new Date('2026-09-15T06:00:00.000Z'); // 15.09 09:00 МСК

describe('окно отчёта — календарный день по Москве', () => {
  it('утром отчёт за вчера', () => {
    expect(previousMskDay(AT_CRON)).toBe('2026-09-14');
  });

  it('вчера считается по Москве, а не по UTC: 15.09 01:00 МСК — это ещё 14.09 в UTC', () => {
    expect(previousMskDay(new Date('2026-09-14T22:00:00.000Z'))).toBe('2026-09-14');
  });

  it('время запуска на окно не влияет: вечером того же дня — всё тот же вчерашний день', () => {
    expect(previousMskDay(new Date('2026-09-15T20:59:59.000Z'))).toBe('2026-09-14');
  });

  it('окно дня — с полуночи до полуночи по Москве, в UTC', () => {
    expect(mskDayRange('2026-09-14')).toEqual({
      since: '2026-09-13T21:00:00.000Z',
      until: '2026-09-14T21:00:00.000Z',
    });
  });
});

describe('resolveReportDay', () => {
  it('без параметра — вчера, полный день', () => {
    expect(resolveReportDay(null, AT_CRON)).toEqual({
      ok: true,
      day: '2026-09-14',
      range: { since: '2026-09-13T21:00:00.000Z', until: '2026-09-14T21:00:00.000Z' },
      partial: false,
    });
  });

  it('сегодняшний день разрешён и помечен неполным', () => {
    const res = resolveReportDay('2026-09-15', AT_CRON);
    expect(res).toMatchObject({ ok: true, day: '2026-09-15', partial: true });
  });

  it('завтрашний день и мусор — отказ', () => {
    expect(resolveReportDay('2026-09-16', AT_CRON)).toEqual({ ok: false, reason: 'future_day' });
    expect(resolveReportDay('14.09.2026', AT_CRON)).toEqual({ ok: false, reason: 'invalid_day' });
    expect(resolveReportDay('2026-02-30', AT_CRON)).toEqual({ ok: false, reason: 'invalid_day' });
  });
});

function paidOrder(over: Partial<DailyPaidOrder> = {}): DailyPaidOrder {
  return {
    shortId: 'ORD-4DYS6',
    paidAt: new Date('2026-09-14T07:09:00.000Z'), // 10:09 МСК
    status: 'completed',
    amountKopecks: 228_000,
    discountKopecks: 0,
    serviceName: 'ChatGPT',
    tierName: 'Plus',
    customDescription: null,
    telegramUsername: 'arthur_test',
    displayName: 'Артур',
    ...over,
  };
}

function reportData(over: Partial<DailyReportData> = {}): DailyReportData {
  return {
    day: '2026-09-14',
    partial: false,
    revenue: { amountKopecks: 684_000, paidOrders: 3, averageKopecks: 228_000, bonusRedeemedKopecks: 0 },
    audience: {
      telegramVisitors: 23,
      botStarts: 9,
      cabinetOpens: 15,
      webVisitors: 41,
      newTelegramUsers: 5,
      referralJoins: 2,
    },
    flow: { created: 7, invoiced: 5, expired: 2, cancelled: 1, failed: 0, paymentReview: 1 },
    paid: { items: [paidOrder()], total: 1 },
    promo: { orders: 0, kopecks: 0 },
    support: { requests: 2, ratings: 3, ratingAverage: 4.7, lowRatings: 1 },
    now: {
      pending: { count: 4, sumKopecks: 912_000 },
      holds: 1,
      unansweredSupport: 0,
      vcc: { balanceUsdCents: 41_250, readAt: new Date('2026-09-14T20:55:00.000Z') },
    },
    ...over,
  };
}

describe('paidOrderLine', () => {
  it('время МСК, @username, сервис с тарифом, сумма, номер; у выполненного статуса нет', () => {
    expect(paidOrderLine(paidOrder())).toBe(
      `10:09 · @arthur_test · ChatGPT Plus · ${formatKopecks(228_000)} · ORD-4DYS6`,
    );
  });

  it('оплата со скидкой — сумма, которую заплатил клиент, и скидка рядом', () => {
    const line = paidOrderLine(paidOrder({ amountKopecks: 228_500, discountKopecks: 43_900 }));
    expect(line).toContain(`${formatKopecks(184_600)} (скидка ${formatKopecks(43_900)})`);
  });

  it('без username — имя, вне каталога — описание; невыполненный получает статус панели', () => {
    const line = paidOrderLine(
      paidOrder({
        telegramUsername: null,
        displayName: 'Боб',
        serviceName: null,
        tierName: null,
        customDescription: 'Midjourney Standard',
        status: 'failed',
      }),
    );
    expect(line).toContain('Боб');
    expect(line).toContain('Midjourney Standard');
    expect(line.endsWith('Ошибка')).toBe(true);
  });
});

describe('formatDailyReport', () => {
  it('заголовок с маркером темы и датой, ключевые цифры и ссылка на раздел отчётов', () => {
    const text = formatDailyReport(reportData(), 'admin.oplatishka.com');

    expect(text.startsWith(`📊 Отчёт за ${formatReportDate('2026-09-14')}\n`)).toBe(true);
    expect(text).toContain('В бот и кабинет: 23 чел.');
    expect(text).toContain('Новых клиентов: 5 · по реф-ссылке: 2');
    expect(text).toContain('Покупок: 3');
    expect(text).toContain('@arthur_test');
    expect(text).toContain('Оценок: 3, средняя 4,7 · низких (1–3): 1');
    expect(text).toContain('Карточный счёт: $412.50 (на 23:55)');
    expect(text).toContain('https://admin.oplatishka.com/admin/analytics');
    // Баллов не было — строки нет, а не «0 ₽».
    expect(text).not.toContain('баллами');
    expect(text).not.toContain('промокодам');
  });

  it('скидки по промокодам — отдельной строкой, чтобы «получено» ниже покупок не читалось недостачей', () => {
    const text = formatDailyReport(reportData({ promo: { orders: 1, kopecks: 43_900 } }), null);
    expect(text).toContain(`Скидки по промокодам: ${formatKopecks(43_900)} (заказов: 1)`);
    expect(text).not.toContain('День ещё не закончился');
  });

  it('пустой день — честные нули и «Оплат не было», непрочитанный пункт — без выдуманного числа', () => {
    const text = formatDailyReport(
      reportData({
        revenue: { amountKopecks: 0, paidOrders: 0, averageKopecks: 0, bonusRedeemedKopecks: 0 },
        paid: { items: [], total: 0 },
        support: { requests: 0, ratings: 0, ratingAverage: null, lowRatings: 0 },
        now: { pending: null, holds: null, unansweredSupport: 3, vcc: null },
        partial: true,
      }),
      null,
    );

    expect(text).toContain('Оплат не было.');
    expect(text).toContain('Покупок: 0\n');
    expect(text).toContain('Оценок не было.');
    expect(text).toContain('Оплаты: не удалось прочитать');
    expect(text).toContain('Карточный счёт: не удалось прочитать');
    expect(text).toContain('День ещё не закончился');
    // Без хоста панели — путь, а не мёртвая ссылка.
    expect(text).toContain('\n/admin/analytics');
  });

  it('список длиннее выборки — «и ещё N» от ПОЛНОГО числа оплат', () => {
    const text = formatDailyReport(reportData({ paid: { items: [paidOrder()], total: 12 } }), null);
    expect(text).toContain('…и ещё 11');
  });

  it('раздутый список укорачивается до лимита Telegram, число скрытых растёт честно', () => {
    const long = 'Очень длинное описание подписки '.repeat(5);
    const items = Array.from({ length: 30 }, (_, i) =>
      paidOrder({
        shortId: `ORD-${String(i).padStart(5, '0')}`,
        telegramUsername: null,
        displayName: long,
        serviceName: null,
        tierName: null,
        customDescription: long,
        status: 'refund_requested',
      }),
    );
    // Имя и описание режутся до 24/36 символов; раздуваем за лимит числом строк.
    const many = Array.from({ length: 80 }, (_, i) => ({ ...items[i % 30]!, shortId: `ORD-${i}` }));

    const text = formatDailyReport(reportData({ paid: { items: many, total: 95 } }), 'admin.oplatishka.com');

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const shownLines = text.split('\n').filter((l) => l.includes(' · ORD-')).length;
    expect(shownLines).toBeLessThan(80);
    expect(text).toContain(`…и ещё ${95 - shownLines}`);
  });

  it('тон безличный — без обращений на «ты»', () => {
    const text = formatDailyReport(reportData({ partial: true }), null);
    expect(text).not.toMatch(/(^|[^а-яё])(ты|тебе|твой|твоя|проверь|посмотри)([^а-яё]|$)/iu);
  });
});
