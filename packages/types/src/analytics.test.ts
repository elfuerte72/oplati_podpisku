import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_EVENTS,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_FUNNEL,
  ANALYTICS_MAX_BATCH,
  ANALYTICS_MAX_CLOCK_SKEW_MS,
  ANALYTICS_MAX_PROPS,
  ANALYTICS_MILESTONES,
  ANALYTICS_PROP_KEYS,
  CLIENT_EVENT_NAMES,
  analyticsDictionaryRows,
  analyticsIngestBatchSchema,
  isClientTrackable,
  resolveOccurredAt,
  sanitizeAnalyticsProps,
  type AnalyticsEventName,
} from './analytics.ts';

describe('реестр событий', () => {
  it('21 собственное событие и 10 вех', () => {
    expect(ANALYTICS_EVENT_NAMES).toHaveLength(21);
    expect(Object.keys(ANALYTICS_MILESTONES)).toHaveLength(10);
  });

  it('имена событий и вех не пересекаются', () => {
    // Пересечение означало бы две записи об одном факте: телеметрия best-effort
    // и запись в одной транзакции с деньгами. Они бы разъехались.
    const milestones = new Set(Object.keys(ANALYTICS_MILESTONES));
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(milestones.has(name)).toBe(false);
    }
  });

  it('у каждого события есть непустое описание', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(ANALYTICS_EVENTS[name].description.length).toBeGreaterThan(20);
      expect(ANALYTICS_EVENTS[name].title.length).toBeGreaterThan(0);
    }
  });

  it('props события объявлены в общем allowlist', () => {
    const allowed = new Set<string>(ANALYTICS_PROP_KEYS);
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const key of ANALYTICS_EVENTS[name].props) {
        expect(allowed.has(key), `${name}.${key} нет в ANALYTICS_PROP_KEYS`).toBe(true);
      }
    }
  });

  it('события бота — только серверные', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      if (ANALYTICS_EVENTS[name].channel === 'bot') {
        expect(isClientTrackable(name)).toBe(false);
      }
    }
  });

  it('CLIENT_EVENT_NAMES не содержит серверных', () => {
    for (const name of CLIENT_EVENT_NAMES) {
      expect(ANALYTICS_EVENTS[name].origin).toBe('client');
    }
    expect(CLIENT_EVENT_NAMES).not.toContain('bot_start' as AnalyticsEventName);
  });

  it('привязка Telegram не является шагом воронки', () => {
    // Она обязательна только для пришедших с сайта: как шаг воронка «сужалась»
    // вверх (7 человек против 11 на следующем шаге, живые данные 2026-07-30).
    expect(ANALYTICS_FUNNEL.map((s) => s.name)).not.toContain('telegram_linked');
  });

  it('шаги воронки идут по порядку и ссылаются на существующие имена', () => {
    const steps = ANALYTICS_FUNNEL.map((s) => s.step);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const events = new Set<string>(ANALYTICS_EVENT_NAMES);
    const milestones = new Set(Object.keys(ANALYTICS_MILESTONES));
    for (const s of ANALYTICS_FUNNEL) {
      const pool = s.from === 'events' ? events : milestones;
      expect(pool.has(s.name), `${s.name} не найден в ${s.from}`).toBe(true);
    }
  });
});

describe('sanitizeAnalyticsProps', () => {
  it('оставляет известные ключи, выбрасывает неизвестные', () => {
    expect(sanitizeAnalyticsProps({ slug: 'spotify', hacker: 'x' })).toEqual({ slug: 'spotify' });
  });

  it('не роняет событие на мусорном вводе', () => {
    expect(sanitizeAnalyticsProps(null)).toEqual({});
    expect(sanitizeAnalyticsProps('строка')).toEqual({});
    expect(sanitizeAnalyticsProps([1, 2])).toEqual({});
    expect(sanitizeAnalyticsProps(undefined)).toEqual({});
  });

  it('обрезает длинные строки', () => {
    const out = sanitizeAnalyticsProps({ path: 'x'.repeat(500) });
    expect(out.path).toHaveLength(200);
  });

  it('пропускает вложенные объекты и нечисловые числа', () => {
    expect(sanitizeAnalyticsProps({ slug: { nested: true }, items: Number.NaN })).toEqual({});
    expect(sanitizeAnalyticsProps({ items: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it('ограничивает число ключей', () => {
    const raw: Record<string, string> = {};
    for (const key of ANALYTICS_PROP_KEYS) raw[key] = 'v';
    const out = sanitizeAnalyticsProps(raw);
    expect(Object.keys(out).length).toBeLessThanOrEqual(ANALYTICS_MAX_PROPS);
  });

  it('PAN-подобные последовательности вырезаются из значений', () => {
    // Allowlist ограничивает ключи, но не содержимое — под разрешённым ключом
    // можно прислать что угодно, включая номер карты (находка ревью).
    expect(sanitizeAnalyticsProps({ plan: '4111111111111111' })).toEqual({ plan: '[REDACTED]' });
    expect(sanitizeAnalyticsProps({ plan: '4111 1111 1111 1111' })).toEqual({ plan: '[REDACTED]' });
    // Короткие числа остаются: год, сумма, позиция — обычные значения.
    expect(sanitizeAnalyticsProps({ plan: 'Individual 2026' })).toEqual({ plan: 'Individual 2026' });
  });

  it('ключа про номер карты в allowlist нет вовсе', () => {
    expect(ANALYTICS_PROP_KEYS as readonly string[]).not.toContain('card_last4');
    expect(sanitizeAnalyticsProps({ card_last4: '4417' })).toEqual({});
  });

  it('булев false сохраняется (а не теряется как falsy)', () => {
    expect(sanitizeAnalyticsProps({ completed: false })).toEqual({ completed: false });
  });
});

describe('resolveOccurredAt', () => {
  const received = new Date('2026-07-30T12:00:00.000Z');

  it('доверяет часам клиента при малом расхождении', () => {
    const client = new Date('2026-07-30T11:59:30.000Z').toISOString();
    expect(resolveOccurredAt(client, received).toISOString()).toBe(client);
  });

  it('время из будущего заменяет серверным', () => {
    const future = new Date('2026-07-30T12:00:01.000Z').toISOString();
    expect(resolveOccurredAt(future, received)).toEqual(received);
  });

  it('сбитые часы (расхождение больше порога) заменяет серверным', () => {
    const stale = new Date(received.getTime() - ANALYTICS_MAX_CLOCK_SKEW_MS - 1000).toISOString();
    expect(resolveOccurredAt(stale, received)).toEqual(received);
  });

  it('мусор вместо даты заменяет серверным', () => {
    expect(resolveOccurredAt('не дата', received)).toEqual(received);
  });
});

describe('схема приёма', () => {
  const valid = {
    // Не hex-строка: gitleaks принимает 16 hex-символов за generic-api-key
    // (энтропия 4.0) и роняет Secret Scan на тестовых данных.
    eventKey: 'test-event-key-1',
    name: 'catalog_open',
    channel: 'web',
    occurredAt: '2026-07-30T12:00:00.000Z',
    props: { items: 18, hacker: 'x' },
  };

  it('парсит батч и чистит props', () => {
    const parsed = analyticsIngestBatchSchema.parse({ events: [valid] });
    expect(parsed.events[0]?.props).toEqual({ items: 18 });
  });

  it('отклоняет неизвестное имя события', () => {
    const bad = { ...valid, name: 'catalogOpened' };
    expect(analyticsIngestBatchSchema.safeParse({ events: [bad] }).success).toBe(false);
  });

  it('отклоняет пустой и переполненный батч', () => {
    expect(analyticsIngestBatchSchema.safeParse({ events: [] }).success).toBe(false);
    const many = Array.from({ length: ANALYTICS_MAX_BATCH + 1 }, () => valid);
    expect(analyticsIngestBatchSchema.safeParse({ events: many }).success).toBe(false);
  });

  it('требует ключ идемпотентности разумной длины', () => {
    expect(analyticsIngestBatchSchema.safeParse({ events: [{ ...valid, eventKey: 'x' }] }).success).toBe(
      false,
    );
  });

  it('orderRef — номер ORD-..., а не UUID заказа', () => {
    // UUID (36 символов) молча отбивал бы ВЕСЬ батч как invalid_body, и событие
    // «нажал Оплатить» из кабинета не писалось бы никогда (находка ревью).
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(analyticsIngestBatchSchema.safeParse({ events: [{ ...valid, orderRef: uuid }] }).success).toBe(
      false,
    );
    expect(
      analyticsIngestBatchSchema.safeParse({ events: [{ ...valid, orderRef: 'ORD-K2M4A' }] }).success,
    ).toBe(true);
  });

  it('событие без props валидно', () => {
    const { props: _props, ...withoutProps } = valid;
    const parsed = analyticsIngestBatchSchema.parse({ events: [withoutProps] });
    expect(parsed.events[0]?.props).toEqual({});
  });
});

describe('analyticsDictionaryRows', () => {
  it('отдаёт все события и вехи с описаниями', () => {
    const rows = analyticsDictionaryRows();
    expect(rows).toHaveLength(21 + 10);
    for (const row of rows) {
      expect(row.description.length).toBeGreaterThan(20);
    }
  });

  it('шаги воронки проставлены ровно у семи строк', () => {
    const withStep = analyticsDictionaryRows().filter((r) => r.funnelStep !== null);
    expect(withStep).toHaveLength(7);
    expect(withStep.map((r) => r.funnelStep).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('имена уникальны — иначе upsert словаря затрёт строку', () => {
    const names = analyticsDictionaryRows().map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
