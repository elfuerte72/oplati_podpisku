import { describe, expect, it } from 'vitest';

import { ANALYTICS_EVENTS, ANALYTICS_MILESTONES } from '@oplati/types';

import { activityChannelLabel, activityDetails, activityTitle } from './client-activity';

describe('подписи ленты действий клиента', () => {
  it('событие и веха называются словами из словаря аналитики', () => {
    expect(activityTitle('catalog_open')).toBe(ANALYTICS_EVENTS.catalog_open.title);
    expect(activityTitle('payment_paid')).toBe(ANALYTICS_MILESTONES.payment_paid.title);
  });

  it('неизвестное имя показывается как есть, а не прочерком', () => {
    // Событие может появиться в базе раньше строки словаря — прочерк скрыл бы,
    // что клиент вообще что-то делал.
    expect(activityTitle('brand_new_event')).toBe('brand_new_event');
  });

  it('у КАЖДОГО события и вехи словаря есть подпись', () => {
    for (const name of [...Object.keys(ANALYTICS_EVENTS), ...Object.keys(ANALYTICS_MILESTONES)]) {
      expect(activityTitle(name)).not.toBe(name);
    }
  });

  it('канал подписан, у вехи канала нет', () => {
    expect(activityChannelLabel('miniapp')).toBe('Кабинет');
    expect(activityChannelLabel('derived')).toBeNull();
  });
});

describe('детали события', () => {
  it('собирает сервис, тариф, страницу, источник и сумму — только известные ключи', () => {
    expect(activityDetails({ slug: 'spotify', plan: 'premium', utm_campaign: 'secret' })).toBe(
      'spotify · premium',
    );
    expect(activityDetails({ path: '/catalog', src: 'tg' })).toBe('/catalog · из tg');
    expect(activityDetails({ amount_kopecks: 123400, amount_usd_cents: 1500 })).toBe(
      formatted(123400),
    );
    expect(activityDetails({ amount_usd_cents: 1500 })).toBe('$15.00');
  });

  it('пустые и нечитаемые детали — прочерк на экране, а не пустая строка', () => {
    expect(activityDetails(null)).toBeNull();
    expect(activityDetails({})).toBeNull();
    expect(activityDetails({ slug: '   ', amount_kopecks: 'много' })).toBeNull();
  });
});

/** Рубли форматируются общей функцией панели; здесь важно, что взяты копейки, а не центы. */
function formatted(kopecks: number): string {
  return `${Math.round(kopecks / 100).toLocaleString('ru-RU')} ₽`;
}
