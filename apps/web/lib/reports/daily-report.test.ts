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
 * Дневной отчёт: границы московских суток и текст. Что держится:
 *   - крон в 00:05 МСК (21:05 UTC) отчитывается за ТОЛЬКО ЧТО закончившиеся сутки;
 *   - окно — ровно [00:00, 24:00) по Москве;
 *   - в списке оплат статус виден только у невыполненных заказов;
 *   - текст всегда влезает в одно сообщение Telegram и не врёт о числе оплат.
 */

const NOW_AFTER_MIDNIGHT_MSK = new Date('2026-09-14T21:05:00.000Z'); // 15.09 00:05 МСК

describe('границы суток по Москве', () => {
  it('после полуночи МСК «прошедшие сутки» — вчерашний московский день', () => {
    expect(previousMskDay(NOW_AFTER_MIDNIGHT_MSK)).toBe('2026-09-14');
  });

  it('ночью по Москве, когда в UTC ещё прошлая дата, «прошедшие сутки» считаются по Москве', () => {
    // 14.09 02:00 МСК = 13.09 23:00 UTC → прошедшие сутки — 13.09.
    expect(previousMskDay(new Date('2026-09-13T23:00:00.000Z'))).toBe('2026-09-13');
  });

  it('окно московского дня в UTC', () => {
    expect(mskDayRange('2026-09-14')).toEqual({
      since: '2026-09-13T21:00:00.000Z',
      until: '2026-09-14T21:00:00.000Z',
    });
  });
});

describe('resolveReportDay', () => {
  it('без параметра — прошедшие сутки, полные', () => {
    expect(resolveReportDay(null, NOW_AFTER_MIDNIGHT_MSK)).toEqual({
      ok: true,
      day: '2026-09-14',
      range: { since: '2026-09-13T21:00:00.000Z', until: '2026-09-14T21:00:00.000Z' },
      partial: false,
    });
  });

  it('сегодняшний день разрешён и помечен неполным', () => {
    const res = resolveReportDay('2026-09-15', NOW_AFTER_MIDNIGHT_MSK);
    expect(res).toMatchObject({ ok: true, day: '2026-09-15', partial: true });
  });

  it('завтрашний день и мусор — отказ', () => {
    expect(resolveReportDay('2026-09-16', NOW_AFTER_MIDNIGHT_MSK)).toEqual({ ok: false, reason: 'future_day' });
    expect(resolveReportDay('14.09.2026', NOW_AFTER_MIDNIGHT_MSK)).toEqual({ ok: false, reason: 'invalid_day' });
    expect(resolveReportDay('2026-02-30', NOW_AFTER_MIDNIGHT_MSK)).toEqual({ ok: false, reason: 'invalid_day' });
  });
});

function paidOrder(over: Partial<DailyPaidOrder> = {}): DailyPaidOrder {
  return {
    shortId: 'ORD-4DYS6',
    paidAt: new Date('2026-09-14T07:09:00.000Z'), // 10:09 МСК
    status: 'completed',
    amountKopecks: 228_000,
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

    expect(text.startsWith(`📊 Отчёт за ${formatReportDate('2026-09-14')}`)).toBe(true);
    expect(text).toContain('В бот и кабинет: 23 чел.');
    expect(text).toContain('Новых клиентов: 5 · по реф-ссылке: 2');
    expect(text).toContain('Покупок: 3');
    expect(text).toContain('@arthur_test');
    expect(text).toContain('Оценок: 3, средняя 4,7 · низких (1–3): 1');
    expect(text).toContain('Карточный счёт: $412.50 (на 23:55)');
    expect(text).toContain('https://admin.oplatishka.com/admin/analytics');
    // Баллов не было — строки нет, а не «0 ₽».
    expect(text).not.toContain('баллами');
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
