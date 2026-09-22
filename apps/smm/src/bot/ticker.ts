import { z } from 'zod';

import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import type { Logger } from '../logger.ts';
import { rankItems } from '../pipeline/rank.ts';
import type { PipelineDeps } from '../pipeline/types.ts';
import type { HttpOptions } from '../sources/http.ts';
import { pollAll } from '../sources/poll/run.ts';
import type { Store } from '../store/index.ts';

/**
 * Тикер источников: раз в несколько часов внутри рабочего окна опрашивает
 * ленты, складывает новое в `items` и оценивает ролью `rank`.
 *
 * ⚠️ Окно по Москве: владелец читает дайджест утром и днём, а ночной прогон
 * тратил бы кредиты ScrapeCreators ради строки в базе, которую никто не
 * откроет до утра.
 */

/** Часовой пояс владельца фиксированный: Москва, UTC+3, без перехода на лето. */
const MSK_OFFSET_HOURS = 3;

export const SETTINGS_DIGEST_ENABLED = 'digest.enabled';
export const SETTINGS_DIGEST_HOUR = 'digest.hour';
export const SETTINGS_DIGEST_LAST_DAY = 'digest.lastDay';

const BooleanSetting = z.boolean();
const HourSetting = z.number().int().min(0).max(23);
const DaySetting = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function mskHour(at: Date): number {
  return (at.getUTCHours() + MSK_OFFSET_HOURS) % 24;
}

/** Календарный день по Москве: по нему считается «дайджест сегодня уже был». */
export function mskDay(at: Date): string {
  const shifted = new Date(at.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function isWithinWindow(at: Date, config: SmmConfig = smmConfig): boolean {
  const hour = mskHour(at);
  const { fromHour, toHour } = config.sources.pollWindowMsk;
  return hour >= fromHour && hour < toHour;
}

export interface TickerDeps {
  readonly store: Store;
  readonly pipeline: PipelineDeps;
  readonly logger: Logger;
  readonly config?: SmmConfig;
  readonly scrapeCreatorsApiKey?: string;
  /** Транспорт опроса: в тестах — двойник, в проде — обычный `fetch`. */
  readonly http?: Pick<HttpOptions, 'fetcher' | 'resolver'>;
  /** Отправка дайджеста владельцу: сам текст собирает бот. */
  readonly sendDigest: () => Promise<void>;
  readonly now?: () => Date;
}

export interface Ticker {
  /** Один прогон. Возвращает, что собрал: удобно тестам и ручному вызову. */
  runOnce(): Promise<{ polled: number; saved: number; ranked: number; skipped?: string }>;
  start(): void;
  stop(): void;
}

export function createTicker(deps: TickerDeps): Ticker {
  const config = deps.config ?? smmConfig;
  const now = deps.now ?? ((): Date => new Date());
  let timer: NodeJS.Timeout | undefined;

  async function maybeSendDigest(at: Date): Promise<void> {
    const enabled = deps.store.settings.get(SETTINGS_DIGEST_ENABLED, BooleanSetting) ?? false;
    if (!enabled) return;
    const hour = deps.store.settings.get(SETTINGS_DIGEST_HOUR, HourSetting) ?? 10;
    if (mskHour(at) < hour) return;
    const today = mskDay(at);
    // Раз в день: прогонов внутри окна несколько, а дайджест один.
    if (deps.store.settings.get(SETTINGS_DIGEST_LAST_DAY, DaySetting) === today) return;
    deps.store.settings.set(SETTINGS_DIGEST_LAST_DAY, DaySetting, today);
    await deps.sendDigest();
  }

  async function runOnce(): Promise<{ polled: number; saved: number; ranked: number; skipped?: string }> {
    const at = now();
    if (!isWithinWindow(at, config)) {
      deps.logger.info({ hourMsk: mskHour(at) }, 'прогон источников вне окна: пропускаю');
      return { polled: 0, saved: 0, ranked: 0, skipped: 'out_of_window' };
    }

    deps.logger.info({}, 'прогон источников начат');
    const since = new Date(at.getTime() - config.sources.digestWindowHours * 60 * 60 * 1000);
    const poll = await pollAll({
      config,
      logger: deps.logger,
      xSince: since,
      ...(deps.http?.fetcher === undefined ? {} : { fetcher: deps.http.fetcher }),
      ...(deps.http?.resolver === undefined ? {} : { resolver: deps.http.resolver }),
      ...(deps.scrapeCreatorsApiKey === undefined
        ? {}
        : { scrapeCreatorsApiKey: deps.scrapeCreatorsApiKey }),
    });

    // Новым считается то, чего ещё нет в базе: решение владельца и оценку
    // повторная встреча не стирает (это делает сам `upsertByUrl`).
    const fresh = poll.items.filter((item) => deps.store.items.findByUrl(item.url) === undefined);
    for (const item of poll.items) {
      deps.store.items.upsertByUrl({
        sourceKind: item.sourceKind,
        url: item.url,
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
      });
    }

    let ranked = 0;
    if (fresh.length > 0) {
      const published = deps.store.posts
        .recentPublished({ platform: 'telegram', limit: 40 })
        .map((post) => ({
          title: (post.body ?? '').split('\n')[0]?.replace(/^#\s*/, '') ?? '',
          ...(post.sourceUrl === undefined ? {} : { url: post.sourceUrl }),
        }));
      const results = await rankItems(
        fresh,
        { published, offtopic: deps.store.offtopic.list(), config },
        deps.pipeline,
      );
      for (const result of results) {
        const stored = deps.store.items.findByUrl(result.item.url);
        if (stored === undefined) continue;
        deps.store.items.setRank(stored.id, result.rank);
        ranked += 1;
      }
    }

    await maybeSendDigest(at);
    deps.logger.info(
      { polled: poll.items.length, saved: fresh.length, ranked, failures: poll.failures.length, credits: poll.credits },
      'прогон источников завершён',
    );
    return { polled: poll.items.length, saved: fresh.length, ranked };
  }

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      const everyMs = config.sources.pollEveryHours * 60 * 60 * 1000;
      timer = setInterval(() => {
        // Прогон живёт минутами и ходит в сеть: его отказ не должен ронять
        // процесс бота, поэтому ошибка ловится здесь и уходит в лог.
        void runOnce().catch((error: unknown) => {
          deps.logger.error({ err: error }, 'прогон источников сорвался');
        });
      }, everyMs);
      // Таймер не держит процесс: бот живёт long polling'ом, а не тикером.
      timer.unref?.();
      deps.logger.info({ everyHours: config.sources.pollEveryHours }, 'тикер источников запущен');
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
