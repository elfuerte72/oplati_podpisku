import { describe, expect, it } from 'vitest';

import { CLIENT_SEGMENT_TITLES, CLIENT_SORT_TITLES } from './labels';
import {
  CLIENT_SEGMENT_OPTIONS,
  CLIENT_SORT_OPTIONS,
  clientsHref,
  parseClientsQuery,
} from './client-filters';

/**
 * Фильтры экрана клиентов живут в адресе — разбор адреса это граница
 * (инвариант 5), и непонятый параметр не показывает «всё подряд» молча.
 */
describe('parseClientsQuery', () => {
  it('пустой адрес — умолчания: все клиенты, новые первыми, всё время', () => {
    expect(parseClientsQuery({})).toEqual({
      query: '',
      segment: 'all',
      sort: 'newest',
      period: null,
      page: 1,
      ignored: [],
    });
  });

  it('разбирает сегмент, сортировку, период и страницу', () => {
    const parsed = parseClientsQuery({
      seg: 'buyers',
      sort: 'active',
      period: '30',
      page: '3',
      q: ' Иван ',
    });

    expect(parsed.segment).toBe('buyers');
    expect(parsed.sort).toBe('active');
    expect(parsed.period).toBe(30);
    expect(parsed.page).toBe(3);
    expect(parsed.query).toBe('Иван');
    expect(parsed.ignored).toEqual([]);
  });

  it('непонятый параметр откатывается к умолчанию и называется по имени', () => {
    const parsed = parseClientsQuery({ seg: 'vip', sort: 'money', period: '14', page: '0' });

    expect(parsed.segment).toBe('all');
    expect(parsed.sort).toBe('newest');
    expect(parsed.period).toBeNull();
    expect(parsed.page).toBe(1);
    expect(parsed.ignored).toEqual(['seg', 'sort', 'period', 'page']);
  });

  it('повторённый параметр берётся первым, длинный поиск режется', () => {
    const parsed = parseClientsQuery({ seg: ['tried', 'buyers'], q: 'a'.repeat(500) });

    expect(parsed.segment).toBe('tried');
    expect(parsed.query).toHaveLength(100);
  });

  it('страница за потолком — не «показать всё», а первая', () => {
    // `?page=1e9` уезжал бы в OFFSET и заставлял базу отматывать миллиард строк.
    expect(parseClientsQuery({ page: '1000000000' }).page).toBe(1);
  });
});

describe('clientsHref', () => {
  it('умолчания в адрес не попадают — ссылка из меню и ссылка «Все» совпадают', () => {
    expect(clientsHref({ segment: 'all', sort: 'newest', page: 1, query: '' })).toEqual({
      pathname: '/admin/clients',
      query: {},
    });
  });

  it('собирает все ключи адреса', () => {
    expect(
      clientsHref({ segment: 'stuck', sort: 'purchased_desc', period: 7, page: 2, query: 'x' }),
    ).toEqual({
      pathname: '/admin/clients',
      query: { seg: 'stuck', sort: 'purchased_desc', period: '7', page: '2', q: 'x' },
    });
  });
});

describe('варианты фильтров', () => {
  it('у каждого сегмента и сортировки репозитория есть подпись', () => {
    for (const option of CLIENT_SEGMENT_OPTIONS) {
      expect(option.title).toBe(CLIENT_SEGMENT_TITLES[option.key]);
      expect(option.title).toMatch(/^[А-ЯЁ]/);
    }
    for (const option of CLIENT_SORT_OPTIONS) {
      expect(option.title).toBe(CLIENT_SORT_TITLES[option.key]);
    }
    expect(CLIENT_SEGMENT_OPTIONS[0]?.key).toBe('all');
  });
});
