import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import type { Logger } from '../logger.ts';
import { fetchText, type HttpOptions } from '../sources/http.ts';
import type { Store } from '../store/index.ts';

/**
 * Просмотры постов канала с витрины `t.me/s/<канал>`.
 *
 * Bot API просмотры своего поста НЕ отдаёт — счётчик есть только на витрине.
 * Номер поста на витрине (`data-post="канал/123"`) — это `message_id`, по нему
 * снимок и сходится с нашим постом.
 *
 * ⚠️ Витрина не рендерит тело rich-постов, но счётчик у них показывает, и это
 * ровно то, что нам нужно: текст поста мы и так знаем.
 */

/** Счётчик витрины: «1.2K», «12.3K», «1M», «834». */
export function parseViews(raw: string): number | undefined {
  const match = /^([\d\s.,]+)\s*([KMkmКМ])?$/.exec(raw.trim());
  if (match === null) return undefined;
  const digits = (match[1] ?? '').replace(/\s/g, '').replace(',', '.');
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  const suffix = (match[2] ?? '').toUpperCase();
  const factor = suffix === 'K' || suffix === 'К' ? 1000 : suffix === 'M' || suffix === 'М' ? 1_000_000 : 1;
  return Math.round(value * factor);
}

/** Пары «номер поста → просмотры» с витрины. */
export function parseWidgetViews(html: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const block of html.split(/<div class="tgme_widget_message[ "]/).slice(1)) {
    const id = Number(/data-post="[^"]*\/(\d+)"/.exec(block)?.[1]);
    if (!Number.isInteger(id)) continue;
    const raw = /<span class="tgme_widget_message_views">([^<]+)<\/span>/.exec(block)?.[1];
    if (raw === undefined) continue;
    const views = parseViews(raw);
    if (views === undefined) continue;
    out.set(id, views);
  }
  return out;
}

export interface CollectViewsDeps {
  readonly store: Store;
  readonly logger: Logger;
  readonly channelUsername: string;
  readonly config?: SmmConfig;
  readonly http?: Pick<HttpOptions, 'fetcher' | 'resolver'>;
  readonly now?: () => Date;
}

export interface CollectViewsResult {
  readonly checked: number;
  readonly recorded: number;
  readonly withdrawn: readonly string[];
  readonly failed?: string;
}

/**
 * Сколько пропусков подряд означает «пост удалили». Один пропуск — не
 * доказательство: витрина отдаёт последние посты страницей, и старый пост
 * пропадает с неё просто по возрасту.
 */
export const WITHDRAW_MISSES = 2;

/** Пост моложе этого срока не хоронится: витрина обновляется не мгновенно. */
export const WITHDRAW_MIN_AGE_HOURS = 48;

export async function collectViews(deps: CollectViewsDeps): Promise<CollectViewsResult> {
  const now = deps.now ?? ((): Date => new Date());
  const channel = deps.channelUsername.replace(/^@/, '').trim();
  const page = await fetchText(`https://t.me/s/${channel}`, {
    ...(deps.http?.fetcher === undefined ? {} : { fetcher: deps.http.fetcher }),
    ...(deps.http?.resolver === undefined ? {} : { resolver: deps.http.resolver }),
    config: deps.config ?? smmConfig,
  });
  if (!page.ok) {
    // Витрина не ответила — это НЕ повод считать посты удалёнными: счётчик
    // пропусков не трогаем вовсе, иначе один сбой сети хоронит канал.
    deps.logger.warn({ channel, reason: page.reason }, 'витрина канала не прочиталась');
    return { checked: 0, recorded: 0, withdrawn: [], failed: page.reason };
  }

  const views = parseWidgetViews(page.text);
  const published = deps.store.posts.listByStatus(['published'], { limit: 200 });
  const withdrawn: string[] = [];
  let recorded = 0;

  for (const post of published) {
    const messageId = post.channelMessageId;
    if (messageId === undefined) continue;
    const seen = views.get(messageId);
    if (seen !== undefined) {
      deps.store.views.record(post.id, seen);
      deps.store.views.seen(post.id);
      recorded += 1;
      continue;
    }

    const publishedAt = post.publishedAt === undefined ? undefined : new Date(post.publishedAt);
    const ageHours =
      publishedAt === undefined ? 0 : (now().getTime() - publishedAt.getTime()) / (60 * 60 * 1000);
    if (ageHours < WITHDRAW_MIN_AGE_HOURS) continue;

    const misses = deps.store.views.missed(post.id);
    if (misses < WITHDRAW_MISSES) continue;

    const moved = deps.store.posts.transition({
      id: post.id,
      from: ['published'],
      to: 'withdrawn',
      decision: { kind: 'withdraw', actor: 'code', payload: { detected: true, misses } },
    });
    if (moved.ok) {
      withdrawn.push(post.id);
      deps.store.views.seen(post.id);
      deps.logger.info({ postId: post.id, misses }, 'пост пропал с витрины: помечен снятым');
    }
  }

  return { checked: published.length, recorded, withdrawn };
}
