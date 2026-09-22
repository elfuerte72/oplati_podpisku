import { smmConfig, type SmmConfig } from '../../config/smm.config.ts';
import type { Logger } from '../../logger.ts';
import type { HttpOptions } from '../http.ts';
import { hackerNews } from './hn.ts';
import { rssFeed } from './rss.ts';
import { redditPosts, threadsSearch, xUser } from './scrape-creators.ts';
import { telegramWidget } from './telegram-widget.ts';
import type { Item, PollResult, SourceKind } from './types.ts';

/**
 * Прогон по всем источникам разом.
 *
 * ⚠️ Отказ ОДНОГО источника не роняет прогон: каналы закрывают витрину,
 * провайдер отвечает 500, у ключа кончаются кредиты — и это обычный вторник.
 * Каждый источник получает свой `started/failed/done` в лог, а наверх уходят
 * все собранные элементы плюс список неудач.
 */

export interface PollTask {
  readonly kind: SourceKind;
  readonly ref: string;
  run(): Promise<PollResult>;
}

export interface PollOptions extends HttpOptions {
  readonly config?: SmmConfig;
  readonly logger: Logger;
  readonly scrapeCreatorsApiKey?: string;
  /** С какого момента твит считается свежим: ручка X отдаёт популярные. */
  readonly xSince?: Date;
}

export interface PollRunResult {
  readonly items: readonly Item[];
  readonly failures: readonly { kind: SourceKind; ref: string; reason: string }[];
  /** Сколько кредитов ScrapeCreators потратил прогон. */
  readonly credits: number;
}

export function pollTasks(options: PollOptions): PollTask[] {
  const config = options.config ?? smmConfig;
  const http: HttpOptions = {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    config,
  };
  const paid = { ...http, ...(options.scrapeCreatorsApiKey === undefined ? {} : { apiKey: options.scrapeCreatorsApiKey }) };

  const tasks: PollTask[] = [];
  for (const channel of config.sources.telegramChannels) {
    tasks.push({ kind: 'telegram', ref: channel, run: () => telegramWidget(channel, http) });
  }
  for (const url of config.sources.rss) {
    tasks.push({ kind: 'rss', ref: url, run: () => rssFeed(url, http) });
  }
  tasks.push({ kind: 'hn', ref: 'topstories', run: () => hackerNews(http) });
  for (const handle of config.sources.xAccounts) {
    tasks.push({
      kind: 'x',
      ref: handle,
      run: () => xUser(handle, { ...paid, ...(options.xSince === undefined ? {} : { since: options.xSince }) }),
    });
  }
  for (const name of config.sources.subreddits) {
    tasks.push({ kind: 'reddit', ref: name, run: () => redditPosts(name, paid) });
  }
  for (const query of config.sources.threadsQueries) {
    tasks.push({ kind: 'threads', ref: query, run: () => threadsSearch(query, paid) });
  }
  return tasks;
}

export async function pollAll(options: PollOptions): Promise<PollRunResult> {
  const tasks = pollTasks(options);
  const items: Item[] = [];
  const failures: { kind: SourceKind; ref: string; reason: string }[] = [];
  let credits = 0;

  for (const task of tasks) {
    options.logger.info({ source: task.kind, ref: task.ref }, 'опрос источника начат');
    const result = await task.run();
    if (!result.ok) {
      // Не бросаем и не прерываемся: следующий источник живёт своей жизнью.
      options.logger.warn(
        { source: task.kind, ref: task.ref, reason: result.reason },
        'опрос источника не удался',
      );
      failures.push({ kind: task.kind, ref: task.ref, reason: result.reason });
      continue;
    }
    credits += result.credits ?? 0;
    items.push(...result.items);
    options.logger.info(
      { source: task.kind, ref: task.ref, items: result.items.length, credits: result.credits ?? 0 },
      'опрос источника завершён',
    );
  }

  return { items, failures, credits };
}
