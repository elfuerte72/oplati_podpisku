import { z } from 'zod';

import { fetchJson, type HttpOptions } from '../http.ts';
import type { Item, PollResult } from './types.ts';

/**
 * ScrapeCreators: X, Threads и Reddit одной кассой. Контракт снят с
 * документации провайдера 22.09.2026 (`docs.scrapecreators.com`): метод GET,
 * ключ в заголовке `x-api-key`, в ответе `success`, `credits_charged` и
 * массив записей.
 *
 * Кредиты считаются в лог: «1 кредит === 1 запрос», и счёт за месяц должен
 * сходиться с тем, что мы думаем о своём расходе.
 *
 * ⚠️ Текст чужих постов наружу НЕ отдаётся — только адрес и заголовок.
 */

const BASE = 'https://api.scrapecreators.com/v1';

export interface ScrapeCreatorsOptions extends HttpOptions {
  readonly apiKey?: string;
}

// ⚠️ Массив записей ОБЯЗАТЕЛЕН в каждой схеме. С `.default([])` смена формы
// ответа («posts» стало «data.children») проходила молча: кредит списан,
// элементов ноль, в логе это неотличимо от «сегодня ничего не нашлось».
const EnvelopeSchema = z.object({
  success: z.boolean().optional(),
  credits_charged: z.number().nonnegative().optional(),
});

const RedditSchema = EnvelopeSchema.extend({
  posts: z
    .array(
      z.object({
        title: z.string().trim().min(1).optional(),
        url: z.string().trim().optional(),
        permalink: z.string().trim().optional(),
        created_at_iso: z.string().trim().optional(),
        over_18: z.boolean().optional(),
      }),
    ),
});

const XSchema = EnvelopeSchema.extend({
  tweets: z
    .array(
      z.object({
        url: z.string().trim().optional(),
        legacy: z
          .object({
            created_at: z.string().trim().optional(),
            id_str: z.string().trim().optional(),
          })
          .optional(),
      }),
    ),
});

const ThreadsSchema = EnvelopeSchema.extend({
  posts: z
    .array(
      z.object({
        code: z.string().trim().optional(),
        taken_at: z.number().int().nonnegative().optional(),
        user: z.object({ username: z.string().trim().optional() }).optional(),
      }),
    ),
});

async function call<S extends z.ZodTypeAny>(
  path: string,
  params: Record<string, string>,
  schema: S,
  options: ScrapeCreatorsOptions,
): Promise<
  | { ok: true; value: z.output<S>; credits: number }
  | { ok: false; reason: string; message: string }
> {
  if (options.apiKey === undefined || options.apiKey === '') {
    // Ключа нет — источник просто не опрашивается. Это настройка, а не авария.
    return { ok: false, reason: 'no_key', message: 'ключ ScrapeCreators не задан' };
  }
  const query = new URLSearchParams(params).toString();
  const answer = await fetchJson<unknown>(`${BASE}${path}?${query}`, {
    ...options,
    headers: { 'x-api-key': options.apiKey },
  });
  if (!answer.ok) return { ok: false, reason: answer.reason, message: answer.message };

  const parsed = schema.safeParse(answer.value);
  if (!parsed.success) {
    return { ok: false, reason: 'contract', message: `ответ ${path} не разобрался схемой` };
  }
  const credits = parsed.data.credits_charged ?? 1;
  return { ok: true, value: parsed.data, credits };
}

/** Внешняя ссылка поста Reddit: обсуждение само по себе материалом не является. */
function redditExternal(url: string | undefined, permalink: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  if (/^https?:\/\/(www\.)?reddit\.com\//i.test(url)) return undefined;
  if (permalink !== undefined && url.endsWith(permalink)) return undefined;
  return url;
}

export async function redditPosts(
  subreddit: string,
  options: ScrapeCreatorsOptions = {},
): Promise<PollResult> {
  const answer = await call(
    '/reddit/subreddit',
    { subreddit, sort: 'top', timeframe: 'day', trim: 'true' },
    RedditSchema,
    options,
  );
  if (!answer.ok) return answer;

  const items: Item[] = [];
  for (const post of answer.value.posts) {
    if (post.over_18 === true) continue;
    const url = redditExternal(post.url, post.permalink);
    if (url === undefined) continue;
    items.push({
      sourceKind: 'reddit',
      sourceRef: subreddit,
      url,
      ...(post.title === undefined ? {} : { title: post.title }),
      ...(post.created_at_iso === undefined ? {} : { publishedAt: post.created_at_iso }),
    });
  }
  return { ok: true, items, credits: answer.credits };
}

export interface XUserOptions extends ScrapeCreatorsOptions {
  /**
   * С какого момента твит считается свежим. ⚠️ Обязателен по делу: ручка
   * отдаёт «100 самых популярных» твитов аккаунта, а не последние, и без
   * отсечки в ленту идей приезжает прошлогоднее.
   */
  readonly since?: Date;
}

export async function xUser(handle: string, options: XUserOptions = {}): Promise<PollResult> {
  const answer = await call('/twitter/user-tweets', { handle, trim: 'true' }, XSchema, options);
  if (!answer.ok) return answer;

  const since = options.since?.getTime() ?? 0;
  const items: Item[] = [];
  for (const tweet of answer.value.tweets) {
    const url = tweet.url;
    if (url === undefined || url === '') continue;
    const created = tweet.legacy?.created_at;
    const at = created === undefined ? undefined : new Date(created);
    const known = at !== undefined && !Number.isNaN(at.getTime());
    // ⚠️ Твит без читаемой даты при заданной отсечке ОТБРАСЫВАЕТСЯ, а не
    // пропускается: ручка отдаёт «100 самых популярных», и без даты в ленту
    // идей приезжает прошлогоднее.
    if (options.since !== undefined && !known) continue;
    if (known && at.getTime() < since) continue;
    items.push({
      sourceKind: 'x',
      sourceRef: handle,
      url,
      ...(known ? { publishedAt: at.toISOString() } : {}),
    });
  }
  return { ok: true, items, credits: answer.credits };
}

export async function threadsSearch(
  query: string,
  options: ScrapeCreatorsOptions = {},
): Promise<PollResult> {
  const answer = await call('/threads/search', { query, trim: 'true' }, ThreadsSchema, options);
  if (!answer.ok) return answer;

  const items: Item[] = [];
  for (const post of answer.value.posts) {
    const username = post.user?.username;
    if (username === undefined || post.code === undefined) continue;
    items.push({
      sourceKind: 'threads',
      sourceRef: query,
      url: `https://www.threads.com/@${username}/post/${post.code}`,
      ...(post.taken_at === undefined
        ? {}
        : { publishedAt: new Date(post.taken_at * 1000).toISOString() }),
    });
  }
  return { ok: true, items, credits: answer.credits };
}
