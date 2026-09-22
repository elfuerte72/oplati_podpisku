import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Article } from './article.ts';
import { articleKey } from './article.ts';

/**
 * Кэш статей на срок из конфига. Нужен ровно для того, чтобы «Другой угол» и
 * круг правок не качали статью заново: владелец жмёт кнопку, а бот думает
 * лишние секунды и тратит трафик на ту же страницу.
 *
 * Файлами, а не в памяти: перезапуск процесса в середине работы над постом —
 * обычное дело при редеплое.
 */

interface CacheEntry {
  readonly savedAt: string;
  readonly article: Article;
}

export interface ArticleCache {
  get(url: string): Article | undefined;
  set(url: string, article: Article): void;
}

export interface ArticleCacheOptions {
  readonly dir: string;
  readonly ttlMs: number;
  readonly now?: () => Date;
  /** Куда сообщать о негодном файле кэша. Молча глотать нельзя. */
  readonly onBroken?: (reason: string) => void;
}

export function createArticleCache(options: ArticleCacheOptions): ArticleCache {
  const now = options.now ?? ((): Date => new Date());
  const pathOf = (url: string): string => join(options.dir, `${articleKey(url)}.json`);

  return {
    get(url) {
      let raw: string;
      try {
        raw = readFileSync(pathOf(url), 'utf8');
      } catch {
        // Файла нет — это не ошибка, это промах кэша.
        return undefined;
      }
      let entry: CacheEntry;
      try {
        entry = JSON.parse(raw) as CacheEntry;
      } catch (error) {
        options.onBroken?.(`кэш статьи ${url} не разобрался: ${String(error)}`);
        return undefined;
      }
      const savedAt = Date.parse(entry.savedAt);
      if (Number.isNaN(savedAt)) {
        options.onBroken?.(`кэш статьи ${url} без времени записи`);
        return undefined;
      }
      if (now().getTime() - savedAt > options.ttlMs) return undefined;
      return entry.article;
    },

    set(url, article) {
      const entry: CacheEntry = { savedAt: now().toISOString(), article };
      try {
        mkdirSync(options.dir, { recursive: true });
        writeFileSync(pathOf(url), JSON.stringify(entry), 'utf8');
      } catch (error) {
        // Кэш — ускорение, а не источник правды: не записался, и ладно.
        options.onBroken?.(`кэш статьи ${url} не записался: ${String(error)}`);
      }
    },
  };
}
