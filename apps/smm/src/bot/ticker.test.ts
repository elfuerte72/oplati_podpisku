import { describe, expect, it } from 'vitest';

import { smmConfig, type ModelRole, type SmmConfig } from '../config/smm.config.ts';
import { createLogger } from '../logger.ts';
import type { Model, ModelResult } from '../llm/model.ts';
import type { Fetcher } from '../sources/index.ts';
import { RSS_XML, TELEGRAM_WIDGET_HTML } from '../sources/poll/fixtures.ts';
import { openStore } from '../store/index.ts';
import {
  createTicker,
  isWithinWindow,
  mskDay,
  mskHour,
  SETTINGS_DIGEST_ENABLED,
  SETTINGS_DIGEST_HOUR,
} from './ticker.ts';
import { z } from 'zod';

const publicDns = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function fakeModel(answers: Partial<Record<ModelRole, unknown[]>>): Model {
  const queues = new Map<ModelRole, unknown[]>(
    Object.entries(answers).map(([role, list]) => [role as ModelRole, [...(list ?? [])]]),
  );
  function next(role: ModelRole): ModelResult<never> {
    const value = queues.get(role)?.shift();
    if (value === undefined) return { ok: false, reason: 'api_error', message: `нет фикстуры ${role}` };
    return { ok: true, value: value as never };
  }
  return {
    json(role) {
      return Promise.resolve(next(role));
    },
    markdown(role) {
      return Promise.resolve(next(role) as ModelResult<string>);
    },
  };
}

function serve(pages: Record<string, string>): Fetcher {
  return (url) => {
    const key = Object.keys(pages).find((candidate) => url.startsWith(candidate));
    if (key === undefined) return Promise.resolve(new Response('нет', { status: 404 }));
    return Promise.resolve(
      new Response(pages[key], { status: 200, headers: { 'content-type': 'text/html' } }),
    );
  };
}

const CONFIG: SmmConfig = {
  ...smmConfig,
  sources: {
    ...smmConfig.sources,
    telegramChannels: ['ainews'],
    rss: [],
  },
};

function setup(options: { now: Date; answers?: Partial<Record<ModelRole, unknown[]>>; weekly?: boolean; views?: boolean }) {
  const store = openStore({ path: ':memory:' });
  const digests: number[] = [];
  const weeklies: number[] = [];
  const viewRuns: number[] = [];
  const fetcher = serve({
    'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML,
    'https://blog.example.com/feed': RSS_XML,
  });
  const ticker = createTicker({
    store,
    pipeline: { model: fakeModel(options.answers ?? {}), logger: silent() },
    http: { fetcher, resolver: publicDns },
    logger: silent(),
    config: CONFIG,
    sendDigest: () => {
      digests.push(1);
      return Promise.resolve();
    },
    ...(options.weekly === true
      ? {
          sendWeekly: () => {
            weeklies.push(1);
            return Promise.resolve();
          },
        }
      : {}),
    ...(options.views === true
      ? {
          collectViews: () => {
            viewRuns.push(1);
            return Promise.resolve();
          },
        }
      : {}),
    now: () => options.now,
  });
  return { store, ticker, digests, weeklies, viewRuns };
}

describe('окно опроса', () => {
  it('считает часы по Москве, а не по серверу', () => {
    expect(mskHour(new Date('2026-09-22T06:00:00.000Z'))).toBe(9);
    expect(mskDay(new Date('2026-09-22T22:30:00.000Z'))).toBe('2026-09-23');
  });

  it('ночью источники не опрашиваются', () => {
    expect(isWithinWindow(new Date('2026-09-22T00:30:00.000Z'), CONFIG)).toBe(false);
    expect(isWithinWindow(new Date('2026-09-22T09:00:00.000Z'), CONFIG)).toBe(true);
  });
});

describe('прогон тикера', () => {
  it('вне окна ничего не делает и говорит об этом', async () => {
    const { ticker, store } = setup({ now: new Date('2026-09-22T01:00:00.000Z') });
    const result = await ticker.runOnce();
    expect(result.skipped).toBe('out_of_window');
    expect(store.items.listRecent()).toHaveLength(0);
    store.close();
  });

  it('складывает найденное и оценивает только НОВОЕ', async () => {
    const answers = {
      rank: [
        [
          {
            url: 'https://blog.example.com/gemini-memory',
            rubric: 'news',
            relevance: 5,
            reader_action: true,
            already_covered: false,
          },
        ],
      ],
    };
    const { ticker, store } = setup({ now: new Date('2026-09-22T07:00:00.000Z'), answers });

    const first = await ticker.runOnce();
    expect(first.saved).toBe(1);
    expect(first.ranked).toBe(1);
    const stored = store.items.findByUrl('https://blog.example.com/gemini-memory');
    expect((stored?.rank as { relevance?: number } | undefined)?.relevance).toBe(5);

    // Второй прогон видит тот же материал: модель к нему больше не зовётся.
    const second = await ticker.runOnce();
    expect(second.saved).toBe(0);
    expect(second.ranked).toBe(0);
    store.close();
  });

  it('дайджест уходит раз в день и только при включённой настройке', async () => {
    const { ticker, store, digests } = setup({ now: new Date('2026-09-22T07:00:00.000Z') });

    await ticker.runOnce();
    expect(digests).toHaveLength(0);

    store.settings.set(SETTINGS_DIGEST_ENABLED, z.boolean(), true);
    store.settings.set(SETTINGS_DIGEST_HOUR, z.number().int(), 10);
    await ticker.runOnce();
    await ticker.runOnce();
    expect(digests).toHaveLength(1);
    store.close();
  });

  it('до назначенного часа дайджест не уходит', async () => {
    const { ticker, store, digests } = setup({ now: new Date('2026-09-22T06:30:00.000Z') });
    store.settings.set(SETTINGS_DIGEST_ENABLED, z.boolean(), true);
    store.settings.set(SETTINGS_DIGEST_HOUR, z.number().int(), 12);
    await ticker.runOnce();
    expect(digests).toHaveLength(0);
    store.close();
  });
});

describe('доранжирование', () => {
  it('элемент, чью пачку не осилила модель, оценивается в следующем прогоне', async () => {
    const at = new Date('2026-09-22T07:00:00.000Z');
    const store = openStore({ path: ':memory:' });
    const fetcher = serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML });

    function tickerWith(answers: Partial<Record<ModelRole, unknown[]>>) {
      return createTicker({
        store,
        pipeline: { model: fakeModel(answers), logger: silent() },
        http: { fetcher, resolver: publicDns },
        logger: silent(),
        config: CONFIG,
        sendDigest: () => Promise.resolve(),
        now: () => at,
      });
    }

    // Первый прогон: модель недоступна — элемент сохранён, но без оценки.
    const first = await tickerWith({}).runOnce();
    expect(first.saved).toBe(1);
    expect(first.ranked).toBe(0);

    // Второй прогон: ничего нового не пришло, а оценка всё равно ставится.
    const second = await tickerWith({
      rank: [
        [
          {
            url: 'https://blog.example.com/gemini-memory',
            relevance: 4,
            reader_action: true,
            already_covered: false,
          },
        ],
      ],
    }).runOnce();
    expect(second.saved).toBe(0);
    expect(second.ranked).toBe(1);
    store.close();
  });

  it('один материал из двух лент — ОДНА строка: хвосты трекинга не в счёт', async () => {
    const at = new Date('2026-09-22T07:00:00.000Z');
    const store = openStore({ path: ':memory:' });
    store.items.upsertByUrl({
      sourceKind: 'rss',
      url: 'https://blog.example.com/gemini-memory?utm_source=habr',
      title: 'Тот же материал',
    });
    const ticker = createTicker({
      store,
      pipeline: { model: fakeModel({}), logger: silent() },
      http: { fetcher: serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML }), resolver: publicDns },
      logger: silent(),
      config: CONFIG,
      sendDigest: () => Promise.resolve(),
      now: () => at,
    });

    const result = await ticker.runOnce();
    expect(result.saved).toBe(0);
    expect(store.items.listRecent({ limit: 50 })).toHaveLength(1);
    store.close();
  });
});

describe('недельная сводка', () => {
  // 2026-09-21 — понедельник; 08:00 UTC = 11:00 МСК.
  const MONDAY = new Date('2026-09-21T08:00:00.000Z');

  it('уходит ОДИН раз при трёх прогонах в понедельник', async () => {
    const { ticker, weeklies, store } = setup({ now: MONDAY, weekly: true });
    await ticker.runOnce();
    await ticker.runOnce();
    await ticker.runOnce();
    expect(weeklies).toHaveLength(1);
    store.close();
  });

  it('во вторник не уходит', async () => {
    const tuesday = new Date('2026-09-22T08:00:00.000Z');
    const { ticker, weeklies, store } = setup({ now: tuesday, weekly: true });
    await ticker.runOnce();
    expect(weeklies).toHaveLength(0);
    store.close();
  });

  it('до 10:00 МСК понедельника не уходит', async () => {
    const early = new Date('2026-09-21T05:00:00.000Z');
    const { ticker, weeklies, store } = setup({ now: early, weekly: true });
    await ticker.runOnce();
    expect(weeklies).toHaveLength(0);
    store.close();
  });
});

describe('сбор просмотров', () => {
  it('идёт по своему расписанию, а не с каждым опросом источников', async () => {
    const { ticker, viewRuns, store } = setup({ now: new Date('2026-09-22T07:00:00.000Z'), views: true });
    await ticker.runOnce();
    await ticker.runOnce();
    expect(viewRuns).toHaveLength(1);
    store.close();
  });
});
