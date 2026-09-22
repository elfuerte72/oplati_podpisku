import { describe, expect, it } from 'vitest';

import type { Fetcher } from '../http.ts';
import {
  ATOM_XML,
  HN_ITEM_ASK,
  HN_ITEM_WITH_URL,
  HN_TOP_STORIES,
  REDDIT_RESPONSE,
  RSS_XML,
  TELEGRAM_WIDGET_HTML,
  THREADS_RESPONSE,
  X_RESPONSE,
} from './fixtures.ts';
import { smmConfig, type SmmConfig } from '../../config/smm.config.ts';
import { createLogger } from '../../logger.ts';
import { hackerNews } from './hn.ts';
import { pollAll, pollTasks } from './run.ts';
import { rssFeed } from './rss.ts';
import { redditPosts, threadsSearch, xUser } from './scrape-creators.ts';
import { telegramWidget } from './telegram-widget.ts';

const publicDns = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);

function serve(pages: Record<string, unknown>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = (url) => {
    calls.push(url);
    const key = Object.keys(pages).find((candidate) => url.startsWith(candidate));
    if (key === undefined) return Promise.resolve(new Response('нет', { status: 404 }));
    const body = pages[key];
    if (typeof body === 'string') {
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetcher, calls };
}

describe('витрина Telegram-канала', () => {
  it('отдаёт адрес первоисточника, а НЕ текст чужого поста', async () => {
    const { fetcher } = serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML });
    const result = await telegramWidget('ainews', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(1);
    const [item] = result.items;
    expect(item?.url).toBe('https://blog.example.com/gemini-memory');
    expect(item?.sourceKind).toBe('telegram');
    expect(item?.sourceRef).toBe('ainews');
    expect(item?.publishedAt).toBe('2026-09-21T08:30:00.000Z');
    // Ни слова из чужого поста наружу: ни в заголовке, ни где-либо ещё.
    const serialized = JSON.stringify(result.items);
    expect(serialized).not.toContain('Google открыла память');
    expect(serialized).not.toContain('мысли вслух');
  });

  it('рекламный пост отсеивается по метке, а не по тексту одной приметы', async () => {
    const { fetcher } = serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML });
    const result = await telegramWidget('ainews', { fetcher, resolver: publicDns });
    expect(result.ok && result.items.map((item) => item.url)).not.toContain(
      'https://course.example.com/',
    );
  });

  it('канал без витрины — отказ, а не пустой список', async () => {
    const { fetcher } = serve({});
    const result = await telegramWidget('closed', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(false);
  });
});

describe('RSS', () => {
  it('читает заголовок, ссылку и дату', async () => {
    const { fetcher } = serve({ 'https://blog.example.com/feed': RSS_XML });
    const result = await rssFeed('https://blog.example.com/feed', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      sourceKind: 'rss',
      url: 'https://blog.example.com/gemini-memory',
      title: 'Gemini запомнил прошлые разговоры',
      publishedAt: '2026-09-21T08:30:00.000Z',
    });
    // Сущности в заголовке раскрыты, элемент без даты не теряется.
    expect(result.items[1]?.title).toBe('Заметка без даты & со ссылкой');
    expect(result.items[1]?.publishedAt).toBeUndefined();
  });

  it('понимает Atom: ссылка живёт в атрибуте', async () => {
    const { fetcher } = serve({ 'https://atom.example.com/feed': ATOM_XML });
    const result = await rssFeed('https://atom.example.com/feed', { fetcher, resolver: publicDns });
    expect(result.ok && result.items[0]?.url).toBe('https://atom.example.com/pricing');
  });
});

describe('Hacker News', () => {
  it('берёт истории со ссылкой наружу и пропускает Ask HN', async () => {
    const { fetcher } = serve({
      'https://hacker-news.firebaseio.com/v0/topstories.json': HN_TOP_STORIES,
      'https://hacker-news.firebaseio.com/v0/item/45123456.json': HN_ITEM_WITH_URL,
      'https://hacker-news.firebaseio.com/v0/item/45123457.json': HN_ITEM_ASK,
      'https://hacker-news.firebaseio.com/v0/item/45123458.json': null,
    });
    const result = await hackerNews({ fetcher, resolver: publicDns, limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKind: 'hn',
      url: 'https://blog.example.com/gemini-memory',
      title: 'Gemini memory for free users',
    });
  });
});

describe('ScrapeCreators', () => {
  it('Reddit: наружу идёт внешняя ссылка, текст поста — нет', async () => {
    const { fetcher, calls } = serve({
      'https://api.scrapecreators.com/v1/reddit/subreddit': REDDIT_RESPONSE,
    });
    const result = await redditPosts('singularity', {
      apiKey: 'sc-test',
      fetcher,
      resolver: publicDns,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://blog.example.com/gemini-memory');
    expect(JSON.stringify(result.items)).not.toContain('текст чужого поста');
    expect(result.credits).toBe(1);
    expect(calls[0]).toContain('subreddit=singularity');
  });

  it('X: отдаются только свежие твиты — ручка возвращает популярные', async () => {
    const { fetcher } = serve({
      'https://api.scrapecreators.com/v1/twitter/user-tweets': X_RESPONSE,
    });
    const result = await xUser('openai', {
      apiKey: 'sc-test',
      fetcher,
      resolver: publicDns,
      since: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://x.com/openai/status/1800000000000000001');
  });

  it('Threads: адрес поста собирается из имени и кода', async () => {
    const { fetcher } = serve({
      'https://api.scrapecreators.com/v1/threads/search': THREADS_RESPONSE,
    });
    const result = await threadsSearch('оплата подписок', {
      apiKey: 'sc-test',
      fetcher,
      resolver: publicDns,
    });
    expect(result.ok && result.items[0]?.url).toBe(
      'https://www.threads.com/@oplatishka/post/DA1bC2d3E4f',
    );
    expect(JSON.stringify(result.ok && result.items)).not.toContain('текст чужого поста');
  });

  it('без ключа источник не опрашивается вовсе', async () => {
    const { fetcher, calls } = serve({});
    const result = await redditPosts('singularity', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'no_key' });
    expect(calls).toEqual([]);
  });
});

describe('прогон по всем источникам', () => {
  it('провал ОДНОГО источника не мешает остальным', async () => {
    const { fetcher } = serve({
      'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML,
      'https://blog.example.com/feed': RSS_XML,
      // Витрина второго канала не отвечает (404 из `serve`), HN тоже молчит.
    });
    const logger = createLogger({ level: 'fatal', stream: { write() {} } });
    const config: SmmConfig = {
      ...smmConfig,
      sources: {
        ...smmConfig.sources,
        telegramChannels: ['ainews', 'closed'],
        rss: ['https://blog.example.com/feed'],
      },
    };

    const result = await pollAll({ config, logger, fetcher, resolver: publicDns });

    // Живые источники собраны, мёртвые названы поимённо.
    expect(result.items.map((item) => item.sourceKind).sort()).toEqual(['rss', 'rss', 'telegram']);
    expect(result.failures.map((failure) => failure.ref)).toContain('closed');
    expect(result.failures.map((failure) => failure.ref)).toContain('topstories');
  });

  it('источники без ключа и без списка просто не опрашиваются', () => {
    const logger = createLogger({ level: 'fatal', stream: { write() {} } });
    const tasks = pollTasks({ logger });
    // По умолчанию списки пусты: остаётся только бесплатный Hacker News.
    expect(tasks.map((task) => task.kind)).toEqual(['hn']);
  });
});
