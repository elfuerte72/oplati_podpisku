import { describe, expect, it } from 'vitest';

import type { Fetcher } from '../http.ts';
import {
  ATOM_XML,
  HN_ITEM_ASK,
  HN_ITEM_WITH_URL,
  HN_TOP_STORIES,
  REDDIT_RESPONSE,
  RSS_XML,
  TELEGRAM_REPLY_HTML,
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
    // Сверка по НАЧАЛУ адреса вместе с его разбором: «похоже на наш адрес»
    // и «это наш адрес» — разные вещи, и двойник не должен учить плохому.
    const target = new URL(url);
    const key = Object.keys(pages).find((candidate) => {
      const want = new URL(candidate);
      return target.host === want.host && target.pathname.startsWith(want.pathname);
    });
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

  it('рекламный пост отсеивается вместе со своим адресом с хвостом', async () => {
    const { fetcher } = serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML });
    const result = await telegramWidget('ainews', { fetcher, resolver: publicDns });
    // ⚠️ Сверка по ХОСТУ: у рекламной ссылки хвост `utm_source` и `erid`, и
    // точное сравнение с голым адресом проходило всегда, а сравнение по
    // началу строки учит плохому («похоже на адрес» ≠ «это адрес»).
    const hosts = result.ok ? result.items.map((item) => new URL(item.url).host) : [];
    expect(hosts).not.toContain('course.example.com');
  });

  it('у поста-ОТВЕТА читается свой текст, а не цитата', async () => {
    const { fetcher } = serve({ 'https://t.me/s/chan': TELEGRAM_REPLY_HTML });
    const result = await telegramWidget('chan', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const urls = result.items.map((item) => item.url);
    // Реклама в СВОЁМ тексте ловится (раньше метки искались в цитате).
    expect(urls.some((url) => url.startsWith('https://course.example.com/'))).toBe(false);
    // Ссылка из цитаты первоисточником не считается.
    expect(urls).not.toContain('https://old-news.example.com/court');
    expect(urls).not.toContain('https://quoted.example.com/old');
    expect(urls).toEqual(['https://blog.example.com/own-source']);
  });

  it('просмотры с витрины доезжают до элемента', async () => {
    const { fetcher } = serve({ 'https://t.me/s/chan': TELEGRAM_REPLY_HTML });
    const result = await telegramWidget('chan', { fetcher, resolver: publicDns });
    expect(result.ok && result.items[0]?.views).toBe(834);
  });

  it('нулевой потолок означает «ничего», а не «всё»', async () => {
    const { fetcher } = serve({ 'https://t.me/s/ainews': TELEGRAM_WIDGET_HTML });
    const result = await telegramWidget('ainews', { fetcher, resolver: publicDns, limit: 0 });
    expect(result.ok && result.items).toEqual([]);
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

  it('у ленты есть потолок: шестисот элементов за прогон не бывает', async () => {
    const many = [
      '<?xml version="1.0"?><rss><channel>',
      ...Array.from(
        { length: 100 },
        (_, index) =>
          `<item><title>Тема ${index}</title><link>https://blog.example.com/${index}</link></item>`,
      ),
      '</channel></rss>',
    ].join('');
    const { fetcher } = serve({ 'https://blog.example.com/big': many });
    const result = await rssFeed('https://blog.example.com/big', { fetcher, resolver: publicDns });
    expect(result.ok && result.items.length).toBe(20);
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

  it('дрейф контракта — ОТКАЗ, а не пустой список за списанный кредит', async () => {
    const { fetcher } = serve({
      // Форма самого Reddit вместо формы провайдера: так выглядит смена
      // контракта, которую раньше проглатывал `.default([])`.
      'https://api.scrapecreators.com/v1/reddit/subreddit': {
        success: true,
        credits_charged: 1,
        data: { children: [{ title: 'Тема' }] },
      },
    });
    const result = await redditPosts('singularity', { apiKey: 'sc-test', fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'contract' });
  });

  it('твит без читаемой даты при заданной отсечке отбрасывается', async () => {
    const { fetcher } = serve({
      'https://api.scrapecreators.com/v1/twitter/user-tweets': {
        success: true,
        credits_charged: 1,
        tweets: [
          { url: 'https://x.com/openai/status/1', legacy: { created_at: 'мусор' } },
          { url: 'https://x.com/openai/status/2' },
        ],
      },
    });
    const result = await xUser('openai', {
      apiKey: 'sc-test',
      fetcher,
      resolver: publicDns,
      since: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(result.ok && result.items).toEqual([]);
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

  it('платный источник не опрашивается дважды в окне кэша', async () => {
    const { fetcher, calls } = serve({
      'https://api.scrapecreators.com/v1/reddit/subreddit': REDDIT_RESPONSE,
    });
    const logger = createLogger({ level: 'fatal', stream: { write() {} } });
    const config: SmmConfig = {
      ...smmConfig,
      sources: { ...smmConfig.sources, subreddits: ['singularity'] },
    };
    const remembered = new Map<string, string>();
    const memory = {
      lastRunAt: (key: string) => remembered.get(key),
      remember: (key: string, at: string) => {
        remembered.set(key, at);
      },
    };
    const at = new Date('2026-09-22T10:00:00.000Z');
    const options = {
      config,
      logger,
      fetcher,
      resolver: publicDns,
      scrapeCreatorsApiKey: 'sc-test',
      memory,
      now: () => at,
    };

    await pollAll(options);
    await pollAll(options);
    const paidCalls = calls.filter((url) => url.includes('scrapecreators'));
    expect(paidCalls).toHaveLength(1);

    // Через тринадцать часов окно кэша прошло — идём снова.
    const later = new Date(at.getTime() + 13 * 60 * 60 * 1000);
    await pollAll({ ...options, now: () => later });
    expect(calls.filter((url) => url.includes('scrapecreators'))).toHaveLength(2);
  });

  it('по умолчанию опрашиваются только бесплатные источники', () => {
    const logger = createLogger({ level: 'fatal', stream: { write() {} } });
    const kinds = new Set(pollTasks({ logger }).map((task) => task.kind));
    // Платные списки пусты до слова владельца: кредиты тратим по его выбору.
    expect(kinds.has('hn')).toBe(true);
    expect(kinds.has('rss')).toBe(true);
    expect(kinds.has('x')).toBe(false);
    expect(kinds.has('reddit')).toBe(false);
    expect(kinds.has('threads')).toBe(false);
  });
});
