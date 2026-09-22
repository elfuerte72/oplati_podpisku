import type { SmmConfig } from '../config/smm.config.ts';
import { fetchArticle, isTelegramUrl, type Article, type FetchArticleOptions } from './article.ts';
import type { Fetcher } from './http.ts';
import { searchNews, type SearchCandidate, type SearchOptions } from './tavily.ts';

/**
 * Что владелец дал боту: ссылку, тему или запрос, на который бот не отвечает.
 *
 * Про сам продукт «Оплатишка» бот не пишет — про него пишет человек (правило
 * SOUL прошлого контура, решение владельца). Отказ выдаётся ДО любых вызовов
 * сети и модели: это не тема канала, и тратить на неё деньги незачем.
 */

export type RefusalReason = 'product_is_human' | 'telegram_post_not_source' | 'empty_input';

export type ResolvedSource =
  | { readonly kind: 'url'; readonly article: Article }
  | { readonly kind: 'topic'; readonly candidates: readonly SearchCandidate[] }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly message: string }
  /** Ссылка дана, но статью прочитать не удалось: причина уходит владельцу. */
  | { readonly kind: 'failed'; readonly reason: string; readonly message: string };

/** Похоже на адрес: с протоколом или без него, но с доменом. */
const URL_LIKE_RE = /^(?:https?:\/\/|www\.)\S+$|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;

/** Упоминание своего продукта в брифе. */
const OWN_PRODUCT_RE = /оплатишк|@oplatishkaa_bot|oplatishka\.com/i;

export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;
  return URL_LIKE_RE.test(trimmed);
}

/** Приводит ссылку к абсолютной: владелец присылает и «www.example.com/post». */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export interface ResolveOptions extends FetchArticleOptions {
  readonly tavilyApiKey?: string;
  readonly searchOptions?: Omit<SearchOptions, 'apiKey' | 'fetcher' | 'config'>;
  readonly fetcher?: Fetcher;
  readonly config?: SmmConfig;
}

export async function resolveSource(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolvedSource> {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { kind: 'refused', reason: 'empty_input', message: 'пришли ссылку или тему словами' };
  }

  if (OWN_PRODUCT_RE.test(trimmed)) {
    return {
      kind: 'refused',
      reason: 'product_is_human',
      message: 'про продукт Оплатишки пишет человек: канал про искусственный интеллект',
    };
  }

  if (looksLikeUrl(trimmed)) {
    const url = normalizeUrl(trimmed);
    if (isTelegramUrl(url)) {
      return {
        kind: 'refused',
        reason: 'telegram_post_not_source',
        message: 'чужой пост в Telegram источником не бывает: дай адрес первоисточника',
      };
    }
    const article = await fetchArticle(url, options);
    if (!article.ok) return { kind: 'failed', reason: article.reason, message: article.message };
    return { kind: 'url', article: article.article };
  }

  const search = await searchNews(trimmed, {
    ...options.searchOptions,
    ...(options.tavilyApiKey === undefined ? {} : { apiKey: options.tavilyApiKey }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  if (!search.ok) return { kind: 'failed', reason: search.reason, message: search.message };
  return { kind: 'topic', candidates: search.candidates };
}
