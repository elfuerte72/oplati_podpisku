import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { fetchJson, type Fetcher } from './http.ts';

/**
 * Поиск первоисточника по теме. Нужен там, где владелец дал не ссылку, а слова:
 * пост обязан стоять на настоящей статье, а не на памяти модели.
 *
 * ⚠️ Контракт снят с документации провайдера (снимок ресерча 22.09.2026):
 * `POST /search`, `topic: 'news'`, `time_range`, `language` (ISO 639-1),
 * `max_results`. Форма авторизации — заголовок `Authorization: Bearer`.
 * Живым вызовом НЕ подтверждён: ключ есть только у владельца, поэтому отказ
 * провайдера обрабатывается как «поиск недоступен», а не как падение.
 */

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface SearchCandidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publishedAt?: string;
  /** Язык запроса, который принёс кандидата: по нему видно, откуда он взялся. */
  readonly language: 'ru' | 'en';
}

export type SearchFailure = 'not_configured' | 'provider_error' | 'empty';

export type SearchResult =
  | { readonly ok: true; readonly candidates: readonly SearchCandidate[] }
  | { readonly ok: false; readonly reason: SearchFailure; readonly message: string };

interface TavilyResponse {
  readonly results?: readonly {
    readonly url?: string;
    readonly title?: string;
    readonly content?: string;
    readonly published_date?: string;
  }[];
}

export interface SearchOptions {
  readonly apiKey?: string;
  readonly languages?: readonly ('ru' | 'en')[];
  readonly timeRange?: 'day' | 'week' | 'month';
  readonly maxResults?: number;
  readonly fetcher?: Fetcher;
  readonly config?: SmmConfig;
}

/** Домен адреса: по нему объединяется выдача на двух языках. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function searchOnce(
  query: string,
  language: 'ru' | 'en',
  apiKey: string,
  options: SearchOptions,
): Promise<{ ok: true; candidates: SearchCandidate[] } | { ok: false; message: string }> {
  const response = await fetchJson<TavilyResponse>(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      query,
      topic: 'news',
      language,
      time_range: options.timeRange ?? 'week',
      max_results: options.maxResults ?? 5,
      search_depth: 'basic',
    },
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  if (!response.ok) return { ok: false, message: response.message };

  const candidates: SearchCandidate[] = [];
  for (const row of response.value.results ?? []) {
    const url = row.url?.trim();
    if (url === undefined || url === '') continue;
    const published = row.published_date === undefined ? undefined : new Date(row.published_date);
    candidates.push({
      url,
      title: row.title?.trim() ?? url,
      snippet: (row.content ?? '').trim().slice(0, 500),
      language,
      ...(published !== undefined && !Number.isNaN(published.getTime())
        ? { publishedAt: published.toISOString() }
        : {}),
    });
  }
  return { ok: true, candidates };
}

/**
 * Пять кандидатов на тему. Два запроса, русский и английский: новость об
 * иностранном сервисе по-русски часто ещё не вышла, а по-английски уже есть.
 * Объединение по ДОМЕНУ: один и тот же материал на двух языках это один
 * источник, и показывать владельцу две кнопки на него нечестно.
 */
export async function searchNews(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const config = options.config ?? smmConfig;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey === '') {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'поиск не настроен: нет ключа TAVILY_API_KEY, дай ссылку на статью',
    };
  }

  const languages = options.languages ?? (['ru', 'en'] as const);
  const problems: string[] = [];
  const byDomain = new Map<string, SearchCandidate>();

  for (const language of languages) {
    const attempt = await searchOnce(query, language, apiKey, { ...options, config });
    if (!attempt.ok) {
      problems.push(`${language}: ${attempt.message}`);
      continue;
    }
    for (const candidate of attempt.candidates) {
      const key = domainOf(candidate.url);
      // Первым побеждает русский язык: владельцу удобнее проверять по-русски.
      if (!byDomain.has(key)) byDomain.set(key, candidate);
    }
  }

  const candidates = [...byDomain.values()].slice(0, options.maxResults ?? 5);
  if (candidates.length === 0) {
    if (problems.length === languages.length) {
      return { ok: false, reason: 'provider_error', message: problems.join('; ') };
    }
    return { ok: false, reason: 'empty', message: 'по этой теме свежих статей не нашлось' };
  }
  return { ok: true, candidates };
}
