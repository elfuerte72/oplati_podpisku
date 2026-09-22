import { z } from 'zod';

import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import type { Logger } from '../logger.ts';
import { rankItems } from '../pipeline/rank.ts';
import type { PipelineDeps } from '../pipeline/types.ts';
import type { HttpOptions } from '../sources/http.ts';
import { pollAll } from '../sources/poll/run.ts';
import type { Item } from '../sources/poll/types.ts';
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
export const SETTINGS_VIEWS_LAST_RUN = 'views.lastRun';
export const SETTINGS_WEEKLY_LAST_WEEK = 'weekly.lastWeek';
/** Префикс памятки платных опросов: одна запись на источник. */
export const SETTINGS_PAID_POLL_PREFIX = 'poll.paid.';

/** Просмотры собираются реже опроса источников: цифра меняется медленно. */
export const VIEWS_EVERY_HOURS = 6;
/** Окно «уже писали» для контекста ранжирования. */
export const COVERED_WINDOW_DAYS = 60;
/** Недельная сводка — понедельник, 10:00 МСК. */
export const WEEKLY_DAY = 1;
export const WEEKLY_HOUR = 10;

const BooleanSetting = z.boolean();
const HourSetting = z.number().int().min(0).max(23);
const DaySetting = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoSetting = z.string().min(1);

export function mskHour(at: Date): number {
  return (at.getUTCHours() + MSK_OFFSET_HOURS) % 24;
}

/** Календарный день по Москве: по нему считается «дайджест сегодня уже был». */
export function mskDay(at: Date): string {
  const shifted = new Date(at.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Номер недели по Москве: ключ дедупа недельной сводки. */
export function mskWeekKey(at: Date): string {
  const shifted = new Date(at.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  const day = (shifted.getUTCDay() + 6) % 7;
  // Понедельник этой недели: сводка одна на неделю, в какой бы день её ни
  // отправили.
  const monday = new Date(shifted.getTime() - day * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
}

/** День недели по Москве: 1 — понедельник. */
export function mskWeekday(at: Date): number {
  const shifted = new Date(at.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
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
  /** Сбор просмотров с витрины: раз в несколько часов, своим расписанием. */
  readonly collectViews?: () => Promise<void>;
  /** Недельная сводка в тему «Отчёты»: понедельник, 10:00 МСК. */
  readonly sendWeekly?: () => Promise<void>;
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
  /** Идёт ли прогон прямо сейчас: шаг таймера короче долгого прогона. */
  let running = false;

  async function maybeSendDigest(at: Date): Promise<void> {
    const enabled = deps.store.settings.get(SETTINGS_DIGEST_ENABLED, BooleanSetting) ?? false;
    if (!enabled) return;
    const hour = deps.store.settings.get(SETTINGS_DIGEST_HOUR, HourSetting) ?? 10;
    if (mskHour(at) < hour) return;
    const today = mskDay(at);
    // Раз в день: прогонов внутри окна несколько, а дайджест один.
    if (deps.store.settings.get(SETTINGS_DIGEST_LAST_DAY, DaySetting) === today) return;
    // ⚠️ День занимается ПОСЛЕ доставки: сорвавшаяся отправка иначе съедала
    // бы сутки, и владелец не получал бы дайджест вовсе.
    await deps.sendDigest();
    deps.store.settings.set(SETTINGS_DIGEST_LAST_DAY, DaySetting, today);
  }

  /** Просмотры собираются по своему расписанию, а не с каждым опросом. */
  async function maybeCollectViews(at: Date): Promise<void> {
    if (deps.collectViews === undefined) return;
    const last = deps.store.settings.get(SETTINGS_VIEWS_LAST_RUN, IsoSetting);
    if (last !== undefined) {
      const passed = at.getTime() - new Date(last).getTime();
      if (Number.isFinite(passed) && passed < VIEWS_EVERY_HOURS * 60 * 60 * 1000) return;
    }
    deps.store.settings.set(SETTINGS_VIEWS_LAST_RUN, IsoSetting, at.toISOString());
    await deps.collectViews();
  }

  async function maybeSendWeekly(at: Date): Promise<void> {
    if (deps.sendWeekly === undefined) return;
    if (mskWeekday(at) !== WEEKLY_DAY || mskHour(at) < WEEKLY_HOUR) return;
    const week = mskWeekKey(at);
    // Дедуп по НЕДЕЛЕ: прогонов в понедельник несколько, сводка одна.
    if (deps.store.settings.get(SETTINGS_WEEKLY_LAST_WEEK, DaySetting) === week) return;
    // Неделя занимается ПОСЛЕ доставки: один сбой Telegram в понедельник утром
    // иначе означает «сводки за эту неделю не будет вовсе».
    await deps.sendWeekly();
    deps.store.settings.set(SETTINGS_WEEKLY_LAST_WEEK, DaySetting, week);
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
      now,
      // Память платных опросов живёт в настройках: она обязана пережить
      // перезапуск, иначе каждый деплой стоил бы полного круга кредитов.
      memory: {
        lastRunAt: (key) => deps.store.settings.get(`${SETTINGS_PAID_POLL_PREFIX}${key}`, IsoSetting),
        remember: (key, atIso) => {
          deps.store.settings.set(`${SETTINGS_PAID_POLL_PREFIX}${key}`, IsoSetting, atIso);
        },
      },
    });

    // Новым считается то, чего ещё нет в базе (сравнение по нормализованному
    // адресу — один материал из трёх лент это один материал).
    let saved = 0;
    for (const item of poll.items) {
      if (deps.store.items.findByUrl(item.url) === undefined) saved += 1;
      deps.store.items.upsertByUrl({
        sourceKind: item.sourceKind,
        url: item.url,
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
      });
    }

    // ⚠️ Оцениваем всё НЕОЦЕНЁННОЕ за окно, а не только новое: пачка, упавшая
    // из-за недоступной модели, иначе оставалась бы без оценки навсегда и
    // лежала бы внизу дайджеста до протухания.
    const window = new Date(at.getTime() - config.sources.digestWindowHours * 60 * 60 * 1000);
    const fresh = deps.store.items.listRecent({
      sinceIso: window.toISOString(),
      onlyUnranked: true,
      onlyUnjudged: true,
      limit: 200,
    });

    let ranked = 0;
    if (fresh.length > 0) {
      // Контекст «уже писали» — посты за 60 дней: более старое читатель как
      // повтор не воспринимает, а место в промпте оно занимает.
      const coveredSince = new Date(at.getTime() - COVERED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const published = deps.store.posts
        .recentPublished({ platform: 'telegram', limit: 60 })
        .filter((post) => (post.publishedAt ?? '') >= coveredSince)
        .map((post) => ({
          title: (post.body ?? '').split('\n')[0]?.replace(/^#\s*/, '') ?? '',
          ...(post.sourceUrl === undefined ? {} : { url: post.sourceUrl }),
        }));
      const results = await rankItems(
        fresh.map((row) => ({
          sourceKind: row.sourceKind as Item['sourceKind'],
          url: row.url,
          ...(row.sourceRef === undefined ? {} : { sourceRef: row.sourceRef }),
          ...(row.title === undefined ? {} : { title: row.title }),
          ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
        })),
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

    await maybeCollectViews(at);
    await maybeSendWeekly(at);
    await maybeSendDigest(at);
    deps.logger.info(
      { polled: poll.items.length, saved, ranked, failures: poll.failures.length, credits: poll.credits },
      'прогон источников завершён',
    );
    return { polled: poll.items.length, saved, ranked };
  }

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      const everyMs = config.sources.pollEveryHours * 60 * 60 * 1000;
      const tick = (): void => {
        // ⚠️ Наложения нет: HN читается по истории за раз, и прогон способен
        // идти дольше шага таймера — второй такой же жёг бы кредиты дважды.
        if (running) {
          deps.logger.info({}, 'прогон источников ещё идёт: пропускаю такт');
          return;
        }
        running = true;
        // Прогон живёт минутами и ходит в сеть: его отказ не должен ронять
        // процесс бота, поэтому ошибка ловится здесь и уходит в лог.
        void runOnce()
          .catch((error: unknown) => {
            deps.logger.error({ err: error }, 'прогон источников сорвался');
          })
          .finally(() => {
            running = false;
          });
      };
      // Первый прогон — сразу: иначе после каждого деплоя лента стоит два
      // часа, а деплой в день — норма.
      tick();
      timer = setInterval(tick, everyMs);
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
