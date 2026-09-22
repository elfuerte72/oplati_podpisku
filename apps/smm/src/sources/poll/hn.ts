import { z } from 'zod';

import { fetchJson, type HttpOptions } from '../http.ts';
import type { Item, PollResult } from './types.ts';

/**
 * Hacker News: официальный Firebase API, без ключа и без лимита запросов
 * (`github.com/HackerNews/API`). Берём верх списка и читаем истории по одной —
 * пакетного метода у них нет.
 */

const BASE = 'https://hacker-news.firebaseio.com/v0';

const TopStoriesSchema = z.array(z.number().int().positive()).max(500);

const StorySchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1).optional(),
  url: z.string().trim().url().optional(),
  time: z.number().int().nonnegative().optional(),
});

export interface HackerNewsOptions extends HttpOptions {
  /** Сколько историй из верха списка читать. Каждая — отдельный запрос. */
  readonly limit?: number;
}

export async function hackerNews(options: HackerNewsOptions = {}): Promise<PollResult> {
  const top = await fetchJson<unknown>(`${BASE}/topstories.json`, options);
  if (!top.ok) return { ok: false, reason: top.reason, message: top.message };

  const parsed = TopStoriesSchema.safeParse(top.value);
  if (!parsed.success) {
    return { ok: false, reason: 'contract', message: 'список историй пришёл не массивом чисел' };
  }

  const items: Item[] = [];
  for (const id of parsed.data.slice(0, options.limit ?? 30)) {
    const story = await fetchJson<unknown>(`${BASE}/item/${id}.json`, options);
    // Одна не прочитавшаяся история не повод терять остальные: верх списка
    // меняется постоянно, и запись могла исчезнуть между двумя запросами.
    if (!story.ok) continue;
    const shape = StorySchema.safeParse(story.value);
    if (!shape.success) continue;

    // `Ask HN` и `Show HN` без ссылки наружу — обсуждение, а не материал:
    // пересказывать в канале нечего.
    const { url, title, time } = shape.data;
    if (url === undefined) continue;
    items.push({
      sourceKind: 'hn',
      sourceRef: 'topstories',
      url,
      ...(title === undefined ? {} : { title }),
      ...(time === undefined ? {} : { publishedAt: new Date(time * 1000).toISOString() }),
    });
  }
  return { ok: true, items };
}
