import { smmConfig, type ChannelKey, type SmmConfig } from '../config/smm.config.ts';
import type { Logger } from '../logger.ts';
import { fetchText, type HttpOptions } from '../sources/http.ts';
import { parseViews, widgetBlocks, widgetViews } from '../sources/poll/telegram-widget.ts';
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

/**
 * Пары «номер поста → просмотры» с витрины.
 *
 * ⚠️ Разбор блоков и счётчика живёт в `sources/poll/telegram-widget.ts`: две
 * реализации одного и того же уже успели разойтись (одна резала пробелы
 * внутри числа, другая нет) — это зеркало, заведённое без нужды.
 */
export function parseWidgetViews(html: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const block of widgetBlocks(html)) {
    const id = Number(/data-post="[^"]*\/(\d+)"/.exec(block)?.[1]);
    if (!Number.isInteger(id)) continue;
    const views = widgetViews(block);
    if (views === undefined) continue;
    out.set(id, views);
  }
  return out;
}

export { parseViews };

export interface CollectViewsDeps {
  readonly store: Store;
  readonly logger: Logger;
  /**
   * Канал, чью витрину читаем. Посты берутся ТОЛЬКО этого канала: у каждого
   * канала свои номера сообщений, и чужой пост, не найденный на витрине,
   * был бы ложно помечен снятым.
   */
  readonly channel: { readonly key: ChannelKey; readonly username: string };
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
  const channel = deps.channel.username.replace(/^@/, '').trim();
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
  // ⚠️ Витрина отдаёт СТРАНИЦУ последних сообщений, а не весь канал. Пост,
  // уехавший за её границу по возрасту, отсутствует на ней всегда — и без
  // этой отсечки сторож хоронил бы канал по мере роста (`withdrawn`
  // терминален, вернуть пост нечем, а владельцу уходит DM на каждый).
  const onPage = [...views.keys()];
  const oldestOnPage = onPage.length === 0 ? undefined : Math.min(...onPage);
  const published = deps.store.posts
    .listByStatus(['published'], { limit: 200 })
    .filter((post) => post.platform === 'telegram' && (post.channel ?? 'main') === deps.channel.key);
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

    // Старше самого старого поста НА СТРАНИЦЕ — значит кончилась страница, а
    // не пост удалён. Пустая страница тоже ничего не доказывает.
    if (oldestOnPage === undefined || messageId < oldestOnPage) continue;

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
