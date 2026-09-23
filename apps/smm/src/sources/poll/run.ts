import { smmConfig, type SmmConfig } from '../../config/smm.config.ts';
import type { Logger } from '../../logger.ts';
import type { HttpOptions } from '../http.ts';
import { forwardFuture } from './forward-future.ts';
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
  /** Платный источник: его опрос стоит кредит и потому проходит через сито. */
  readonly paid?: boolean;
  run(): Promise<PollResult>;
}

/**
 * Память о платных опросах: «когда последний раз ходили к провайдеру».
 *
 * ⚠️ Кредиты ScrapeCreators не возобновляются, а прогонов в сутки семь. Без
 * этого сита каждый X-аккаунт, сабреддит и запрос Threads жгли бы семь
 * кредитов в день вместо двух.
 */
export interface PaidPollMemory {
  lastRunAt(key: string): string | undefined;
  remember(key: string, atIso: string): void;
}

export interface PollOptions extends HttpOptions {
  readonly config?: SmmConfig;
  readonly logger: Logger;
  readonly scrapeCreatorsApiKey?: string;
  /** С какого момента твит считается свежим: ручка X отдаёт популярные. */
  readonly xSince?: Date;
  /** Память платных опросов. Не задана — сито выключено (тесты). */
  readonly memory?: PaidPollMemory;
  readonly now?: () => Date;
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
  if (config.sources.forwardFutureIssues > 0) {
    tasks.push({
      kind: 'forwardfuture',
      ref: 'newsletter/daily',
      run: () => forwardFuture({ ...http, issues: config.sources.forwardFutureIssues }),
    });
  }
  tasks.push({ kind: 'hn', ref: 'topstories', run: () => hackerNews(http) });
  for (const handle of config.sources.xAccounts) {
    tasks.push({
      kind: 'x',
      ref: handle,
      paid: true,
      run: () => xUser(handle, { ...paid, ...(options.xSince === undefined ? {} : { since: options.xSince }) }),
    });
  }
  for (const name of config.sources.subreddits) {
    tasks.push({ kind: 'reddit', ref: name, paid: true, run: () => redditPosts(name, paid) });
  }
  for (const query of config.sources.threadsQueries) {
    tasks.push({ kind: 'threads', ref: query, paid: true, run: () => threadsSearch(query, paid) });
  }
  return tasks;
}

export async function pollAll(options: PollOptions): Promise<PollRunResult> {
  const tasks = pollTasks(options);
  const items: Item[] = [];
  const failures: { kind: SourceKind; ref: string; reason: string }[] = [];
  let credits = 0;

  const now = options.now ?? ((): Date => new Date());
  const cacheMs = (options.config ?? smmConfig).sources.cacheHours * 60 * 60 * 1000;

  for (const task of tasks) {
    const key = `${task.kind}:${task.ref}`;
    if (task.paid === true && options.memory !== undefined) {
      const last = options.memory.lastRunAt(key);
      const passed = last === undefined ? Infinity : now().getTime() - new Date(last).getTime();
      if (Number.isFinite(passed) && passed < cacheMs) {
        options.logger.info({ source: task.kind, ref: task.ref }, 'платный источник ещё свеж: кредит не тратим');
        continue;
      }
    }
    options.logger.info({ source: task.kind, ref: task.ref }, 'опрос источника начат');
    const result = await task.run();
    if (!result.ok) {
      // Не бросаем и не прерываемся: следующий источник живёт своей жизнью.
      // Причина идёт ВМЕСТЕ с сообщением: «contract» без текста разбирать
      // нечем, а тело ответа провайдера как раз в нём.
      options.logger.warn(
        { source: task.kind, ref: task.ref, reason: result.reason, message: result.message },
        'опрос источника не удался',
      );
      failures.push({ kind: task.kind, ref: task.ref, reason: result.reason });
      continue;
    }
    if (result.warnings !== undefined && result.warnings.length > 0) {
      options.logger.warn(
        { source: task.kind, ref: task.ref, warnings: result.warnings },
        'опрос источника: часть не разобралась',
      );
    }
    credits += result.credits ?? 0;
    // Успешный платный опрос запоминается: следующий прогон в окне кэша его
    // пропустит. Неудачный НЕ запоминается — иначе сбой провайдера означал бы
    // полсуток тишины по этому источнику.
    if (task.paid === true) options.memory?.remember(key, now().toISOString());
    items.push(...result.items);
    options.logger.info(
      { source: task.kind, ref: task.ref, items: result.items.length, credits: result.credits ?? 0 },
      'опрос источника завершён',
    );
  }

  return { items, failures, credits };
}
