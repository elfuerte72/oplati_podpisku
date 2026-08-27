import { describe, expect, it } from 'vitest';

import { PRESET_TITLES, SORT_TITLES } from './labels';
import {
  SORT_OPTIONS,
  STATUS_PRESETS,
  orderShortIdSchema,
  ordersHref,
  parseOrdersQuery,
} from './order-filters';

/**
 * Фильтры экрана заказов живут в АДРЕСЕ, чтобы ссылку можно было переслать
 * коллеге. Значит разбор адреса — граница (инвариант 5) и обязан быть
 * предсказуемым: непонятый параметр не показывает «всё подряд» молча.
 */
describe('parseOrdersQuery', () => {
  it('пустой адрес — разумные значения по умолчанию', () => {
    const res = parseOrdersQuery({});

    expect(res).toMatchObject({
      query: '',
      status: null,
      sort: 'newest',
      page: 1,
      ignored: [],
    });
    expect(res.preset.key).toBe('all');
  });

  it('поиск обрезается по потолку длины', () => {
    const res = parseOrdersQuery({ q: 'ы'.repeat(500) });

    expect(res.query.length).toBe(100);
  });

  it('пробелы вокруг поиска не считаются вводом', () => {
    expect(parseOrdersQuery({ q: '   ' }).query).toBe('');
  });

  it('точечный статус разбирается схемой', () => {
    expect(parseOrdersQuery({ status: 'payment_review' }).status).toBe('payment_review');
  });

  it('НЕВАЛИДНЫЙ статус не игнорируется молча — экран об этом скажет', () => {
    const res = parseOrdersQuery({ status: 'нет-такого' });

    expect(res.status).toBeNull();
    expect(res.ignored).toContain('status');
  });

  it('незнакомый пресет и сортировка тоже попадают в «не разобрано»', () => {
    const res = parseOrdersQuery({ s: 'выдуманный', sort: 'по-настроению' });

    expect(res.preset.key).toBe('all');
    expect(res.sort).toBe('newest');
    expect(res.ignored).toEqual(expect.arrayContaining(['s', 'sort']));
  });

  it('страница — целое от единицы', () => {
    expect(parseOrdersQuery({ page: '3' }).page).toBe(3);
    expect(parseOrdersQuery({ page: '0' }).page).toBe(1);
    expect(parseOrdersQuery({ page: '-2' }).page).toBe(1);
    expect(parseOrdersQuery({ page: 'абв' }).ignored).toContain('page');
  });

  it('повторённый параметр берёт первое значение, а не массив', () => {
    expect(parseOrdersQuery({ q: ['ORD-AAAAA', 'ORD-BBBBB'] }).query).toBe('ORD-AAAAA');
  });

  it('каждый пресет ссылается на реальные статусы заказа', () => {
    for (const preset of STATUS_PRESETS) {
      expect(Array.isArray(preset.statuses)).toBe(true);
    }
  });

  it('названия пресетов и сортировок берутся из словаря панели', () => {
    // Ключ адреса не меняется, текст живёт в одном месте: «Недожатые» здесь
    // было третьей копией термина.
    for (const preset of STATUS_PRESETS) {
      expect(preset.title).toBe(PRESET_TITLES[preset.key]);
    }
    for (const option of SORT_OPTIONS) {
      expect(option.title).toBe(SORT_TITLES[option.key]);
    }
  });
});

describe('orderShortIdSchema', () => {
  it('нормальный номер принимается в любом регистре', () => {
    expect(orderShortIdSchema.safeParse('ORD-J6TBP').success).toBe(true);
    expect(orderShortIdSchema.safeParse('ord-j6tbp').success).toBe(true);
    expect(orderShortIdSchema.safeParse('  ORD-J6TBP  ').success).toBe(true);
  });

  it('мусор отвергается ДО запроса в базу', () => {
    for (const junk of ['', '%', 'ORD-', 'ORD-TOOLONG', 'что угодно', "ORD-'; drop"]) {
      expect(orderShortIdSchema.safeParse(junk).success).toBe(false);
    }
  });

  it('буквы, исключённые из алфавита номера, не проходят', () => {
    // `I`, `L`, `O`, `U` выброшены из SHORT_ID_ALPHABET как похожие на цифры.
    expect(orderShortIdSchema.safeParse('ORD-IIIII').success).toBe(false);
  });
});

describe('ordersHref', () => {
  it('значения по умолчанию в адрес не пишутся — ссылка остаётся короткой', () => {
    expect(ordersHref({ presetKey: 'all', sort: 'newest', page: 1 })).toEqual({
      pathname: '/admin/orders',
      query: {},
    });
  });

  it('состояние фильтров переживает пересылку ссылки', () => {
    expect(
      ordersHref({ presetKey: 'review', query: 'ORD-J6TBP', sort: 'amount_desc', page: 2 }),
    ).toEqual({
      pathname: '/admin/orders',
      query: { s: 'review', q: 'ORD-J6TBP', sort: 'amount_desc', page: '2' },
    });
  });

  it('разобранный адрес и собранный сходятся', () => {
    const parsed = parseOrdersQuery({ s: 'failed', q: 'ivan', sort: 'oldest', page: '4' });

    expect(
      ordersHref({
        presetKey: parsed.preset.key,
        query: parsed.query,
        sort: parsed.sort,
        page: parsed.page,
      }),
    ).toEqual({
      pathname: '/admin/orders',
      query: { s: 'failed', q: 'ivan', sort: 'oldest', page: '4' },
    });
  });
});
