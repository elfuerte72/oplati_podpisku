import type { ZodType } from 'zod';

import type { ChannelKey } from '../config/smm.config.ts';
import type { Db, SqlValue } from './db.ts';
import { NOT_CHANNEL_COPY_SQL, type OnCorruptJson } from './posts.ts';
import type { FlowRow, Item, NewItem, UsageByRole, UsageInput, UsageSummary } from './types.ts';
import { normalizeUrl } from '../url.ts';
import { ulid } from './ulid.ts';

// ------------------------------------------------------------------ flow

export interface FlowRepo {
  /** Строка диалога: срок хранится как есть, вывод о нём делает автомат. */
  get(ownerId: number): FlowRow | undefined;
  set(ownerId: number, row: Omit<FlowRow, 'updatedAt'>): FlowRow;
  clear(ownerId: number): void;
}

interface FlowDbRow {
  state: string;
  post_id: string | null;
  payload: string | null;
  expires_at: string | null;
  updated_at: string;
}

function parseJson(raw: string | null, onCorrupt?: OnCorruptJson): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Молчать нельзя: без payload у владельца перестают работать ВСЕ кнопки
    // («Кнопка устарела» на каждое нажатие), а причина не видна ниоткуда.
    onCorrupt?.(`состояние диалога: payload не разобрался как JSON (${String(error)})`);
    return undefined;
  }
}

export function createFlowRepo(db: Db, now: () => Date, onCorrupt?: OnCorruptJson): FlowRepo {
  return {
    get(ownerId) {
      const row = db.get<FlowDbRow>('SELECT * FROM flow WHERE owner_id = ?', ownerId);
      if (row === undefined) return undefined;
      // ⚠️ Протухание здесь НЕ считается: его считает автомат по времени
      // СОБЫТИЯ (`event.at`), и вторая формула по стенным часам давала бы
      // два разных ответа на один и тот же клик.
      return {
        state: row.state,
        postId: row.post_id ?? undefined,
        payload: parseJson(row.payload, onCorrupt),
        expiresAt: row.expires_at ?? undefined,
        updatedAt: row.updated_at,
      };
    },
    set(ownerId, row) {
      const at = now().toISOString();
      db.run(
        `INSERT INTO flow (owner_id, state, post_id, payload, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET
           state = excluded.state,
           post_id = excluded.post_id,
           payload = excluded.payload,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
        ownerId,
        row.state,
        row.postId ?? null,
        row.payload === undefined ? null : JSON.stringify(row.payload),
        row.expiresAt ?? null,
        at,
      );
      return { ...row, updatedAt: at };
    },
    clear(ownerId) {
      db.run('DELETE FROM flow WHERE owner_id = ?', ownerId);
    },
  };
}

// ------------------------------------------------------------------ items

export interface ItemsRepo {
  /**
   * Вставка или обновление по адресу первоисточника. Один материал приходит из
   * канала, RSS и X одновременно — дедуп по `url`, а решение владельца
   * (`verdict`) и оценка ранжирования при повторной встрече НЕ стираются.
   */
  upsertByUrl(item: NewItem): Item;
  findByUrl(url: string): Item | undefined;
  /** Элемент по id: его называет кнопка дайджеста идей. */
  findById(id: string): Item | undefined;
  listRecent(options?: {
    sinceIso?: string;
    limit?: number;
    onlyUnjudged?: boolean;
    /** Только неоценённые: пачка, упавшая из-за модели, должна вернуться. */
    onlyUnranked?: boolean;
    /** Без идей, уже взятых в работу. */
    onlyNotTaken?: boolean;
  }): Item[];
  /**
   * Взять идею в работу. Условная запись: false — идею уже взяли (другой
   * прогон, кнопка из старого дайджеста) или по ней уже решено. Один путь на
   * черновик по расписанию и на «Написать»: иначе одна тема писалась бы дважды.
   */
  claim(id: string): boolean;
  /** Вернуть идею в дайджест: ручной разбор не открыл статью. */
  release(id: string): void;
  /** false — элемента с таким id нет: молча промахнуться нельзя. */
  markVerdict(id: string, verdict: NonNullable<Item['verdict']>): boolean;
  setRank(id: string, rank: unknown): boolean;
}

interface ItemDbRow {
  id: string;
  source_kind: string;
  source_ref: string | null;
  url: string;
  title: string | null;
  published_at: string | null;
  seen_at: string;
  rank: string | null;
  verdict: string | null;
  taken_at: string | null;
}

function toItem(row: ItemDbRow): Item {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref ?? undefined,
    url: row.url,
    title: row.title ?? undefined,
    publishedAt: row.published_at ?? undefined,
    seenAt: row.seen_at,
    rank: parseJson(row.rank),
    verdict: (row.verdict as Item['verdict']) ?? undefined,
    takenAt: row.taken_at ?? undefined,
  };
}

export function createItemsRepo(db: Db, now: () => Date): ItemsRepo {
  const repo: ItemsRepo = {
    upsertByUrl(item) {
      const at = now().toISOString();
      db.run(
        `INSERT INTO items (id, source_kind, source_ref, url, url_key, title, published_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url_key) DO UPDATE SET
           title = COALESCE(excluded.title, items.title),
           published_at = COALESCE(excluded.published_at, items.published_at),
           seen_at = excluded.seen_at`,
        ulid(now().getTime()),
        item.sourceKind,
        item.sourceRef ?? null,
        item.url,
        normalizeUrl(item.url),
        item.title ?? null,
        item.publishedAt ?? null,
        at,
      );
      const stored = repo.findByUrl(item.url);
      if (stored === undefined) throw new Error(`элемент ${item.url} не записался`);
      return stored;
    },
    findById(id) {
      const row = db.get<ItemDbRow>('SELECT * FROM items WHERE id = ?', id);
      return row === undefined ? undefined : toItem(row);
    },

    findByUrl(url) {
      // Поиск по КЛЮЧУ: тот же материал с чужим `utm_source` — это он же.
      const row = db.get<ItemDbRow>('SELECT * FROM items WHERE url_key = ?', normalizeUrl(url));
      return row === undefined ? undefined : toItem(row);
    },
    listRecent(options = {}) {
      const rows = db.all<ItemDbRow>(
        `SELECT * FROM items
          WHERE (? IS NULL OR seen_at >= ?)
            AND (? = 0 OR verdict IS NULL)
            AND (? = 0 OR rank IS NULL)
            AND (? = 0 OR taken_at IS NULL)
          ORDER BY COALESCE(published_at, seen_at) DESC, id DESC
          LIMIT ?`,
        options.sinceIso ?? null,
        options.sinceIso ?? null,
        options.onlyUnjudged === true ? 1 : 0,
        options.onlyUnranked === true ? 1 : 0,
        options.onlyNotTaken === true ? 1 : 0,
        options.limit ?? 50,
      );
      return rows.map(toItem);
    },
    markVerdict(id, verdict) {
      return db.run('UPDATE items SET verdict = ? WHERE id = ?', verdict, id).changes > 0;
    },
    claim(id) {
      return (
        db.run(
          'UPDATE items SET taken_at = ? WHERE id = ? AND taken_at IS NULL AND verdict IS NULL',
          now().toISOString(),
          id,
        ).changes > 0
      );
    },
    release(id) {
      db.run('UPDATE items SET taken_at = NULL WHERE id = ? AND verdict IS NULL', id);
    },
    setRank(id, rank) {
      return db.run('UPDATE items SET rank = ? WHERE id = ?', JSON.stringify(rank), id).changes > 0;
    },
  };
  return repo;
}

// ------------------------------------------------------------------ usage

export interface UsageRepo {
  add(entry: UsageInput): void;
  /** Расход за календарный месяц UTC, `yyyy-mm`. */
  sumByMonth(month: string): UsageSummary;
  countSince(sinceIso: string): number;
}

export function createUsageRepo(db: Db, now: () => Date): UsageRepo {
  return {
    add(entry) {
      // «Деньги — integer в минимальных единицах» проверяется, а не
      // округляется: передадут доллары (0.00045) — в базу лёг бы ноль, и
      // месячный счёт занизился бы молча.
      for (const [field, value] of Object.entries({
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheHitTokens: entry.cacheHitTokens,
        usdMicros: entry.usdMicros,
      })) {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(`usage.${field}: ожидается целое неотрицательное, получено ${String(value)}`);
        }
      }
      db.run(
        `INSERT INTO usage (post_id, role, model, input_tokens, output_tokens, cache_hit_tokens,
           usd_micros, is_peak, price_known, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.postId ?? null,
        entry.role,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheHitTokens,
        entry.usdMicros,
        entry.isPeak ? 1 : 0,
        entry.priceKnown ? 1 : 0,
        now().toISOString(),
      );
    },
    sumByMonth(month) {
      // Проверяется и диапазон: `2026-13` дал бы январь следующего года, и
      // сводка молча посчитала бы чужой месяц.
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`месяц ожидается как yyyy-mm (01-12), а не «${month}»`);
      }
      const [yearRaw, monthRaw] = month.split('-');
      const year = Number(yearRaw);
      const monthIndex = Number(monthRaw) - 1;
      // Полуоткрытое окно по UTC: сравнение ISO-строк лексикографически верно,
      // а `LIKE '2026-09%'` не дал бы использовать индекс по created_at.
      const from = new Date(Date.UTC(year, monthIndex, 1)).toISOString();
      const to = new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString();
      const rows = db.all<{
        role: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cache_hit_tokens: number;
        usd_micros: number;
        unknown_price: number;
      }>(
        `SELECT role,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
                COALESCE(SUM(usd_micros), 0) AS usd_micros,
                SUM(CASE WHEN price_known = 0 THEN 1 ELSE 0 END) AS unknown_price
           FROM usage
          WHERE created_at >= ? AND created_at < ?
          GROUP BY role
          ORDER BY usd_micros DESC`,
        from,
        to,
      );
      const byRole: UsageByRole[] = rows.map((row) => ({
        role: row.role,
        calls: row.calls,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheHitTokens: row.cache_hit_tokens,
        usdMicros: row.usd_micros,
      }));
      return {
        usdMicros: byRole.reduce((acc, row) => acc + row.usdMicros, 0),
        calls: byRole.reduce((acc, row) => acc + row.calls, 0),
        byRole,
        hasUnknownPrice: rows.some((row) => row.unknown_price > 0),
      };
    },
    countSince(sinceIso) {
      const row = db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM usage WHERE created_at >= ?',
        sinceIso,
      );
      return row?.n ?? 0;
    },
  };
}

// ------------------------------------------------------------------ settings

export interface SettingsRepo {
  /**
   * Значение настройки. Негодное (не прошло схему) не возвращается: вызывающий
   * получает `undefined` и берёт свой дефолт, а `onInvalid` даёт ему шанс это
   * заметить — молча превращать мусор в дефолт нельзя.
   */
  get<T>(key: string, schema: ZodType<T>, onInvalid?: (reason: string) => void): T | undefined;
  set<T>(key: string, schema: ZodType<T>, value: T): T;
  remove(key: string): void;
  keys(): string[];
}

export function createSettingsRepo(db: Db, now: () => Date): SettingsRepo {
  return {
    get(key, schema, onInvalid) {
      const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
      if (row === undefined) return undefined;
      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch {
        onInvalid?.(`настройка «${key}»: значение не разобралось как JSON`);
        return undefined;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        onInvalid?.(`настройка «${key}»: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        return undefined;
      }
      return parsed.data;
    },
    set(key, schema, value) {
      // Проверка НА ЗАПИСИ, а не только на чтении: негодное значение не должно
      // попадать в базу вовсе.
      const parsed = schema.parse(value);
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(parsed),
        now().toISOString(),
      );
      return parsed;
    },
    remove(key) {
      db.run('DELETE FROM settings WHERE key = ?', key);
    },
    keys() {
      return db.all<{ key: string }>('SELECT key FROM settings ORDER BY key').map((r) => r.key);
    },
  };
}

// ------------------------------------------------------------------ offtopic

export interface OfftopicRepo {
  add(title: string): void;
  list(limit?: number): string[];
}

export function createOfftopicRepo(db: Db, now: () => Date): OfftopicRepo {
  return {
    add(title) {
      const trimmed = title.trim();
      if (trimmed === '') return;
      // OR IGNORE: повторное «не по теме» на ту же тему — обычное дело.
      db.run(
        'INSERT OR IGNORE INTO offtopic (title, created_at) VALUES (?, ?)',
        trimmed,
        now().toISOString(),
      );
    },
    list(limit = 50) {
      return db
        .all<{ title: string }>('SELECT title FROM offtopic ORDER BY id DESC LIMIT ?', limit)
        .map((row) => row.title);
    },
  };
}

/**
 * Просмотры и сторож снятых постов (тикет 11).
 *
 * Витрина канала — единственный доступный счётчик: Bot API просмотры своего
 * поста не отдаёт. Цифра добирается день-два, поэтому храним СНИМКИ.
 */
export interface ViewsRepo {
  record(postId: string, views: number): void;
  /** Последний снимок поста. */
  latest(postId: string): { views: number; takenAt: string } | undefined;
  /** Лучший и средний по постам, опубликованным в окне. */
  summary(
    sinceIso: string,
    channel?: ChannelKey,
  ): { average: number; best?: { postId: string; views: number }; counted: number };
  /** Пост не найден на витрине: счётчик пропусков растёт. Возвращает новое число. */
  missed(postId: string): number;
  /** Пост снова виден: счётчик пропусков обнуляется. */
  seen(postId: string): void;
}

export function createViewsRepo(db: Db, now: () => Date): ViewsRepo {
  return {
    record(postId, views) {
      if (!Number.isInteger(views) || views < 0) {
        throw new Error(`views: ожидается целое неотрицательное, получено ${String(views)}`);
      }
      db.run(
        'INSERT INTO views_snapshots (post_id, views, taken_at) VALUES (?, ?, ?)',
        postId,
        views,
        now().toISOString(),
      );
    },

    latest(postId) {
      const row = db.get<{ views: number; taken_at: string }>(
        'SELECT views, taken_at FROM views_snapshots WHERE post_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1',
        postId,
      );
      return row === undefined ? undefined : { views: row.views, takenAt: row.taken_at };
    },

    summary(sinceIso, channel) {
      // По ПОСЛЕДНЕМУ снимку каждого поста: снимков у поста много, и сумма по
      // всем строкам считала бы один пост несколько раз. Канал — отдельно:
      // средняя по двум аудиториям разного размера не говорит ни о какой.
      const rows = db.all<{ post_id: string; views: number }>(
        `SELECT s.post_id AS post_id, MAX(s.views) AS views
           FROM views_snapshots s
           JOIN posts p ON p.id = s.post_id
          WHERE p.published_at IS NOT NULL AND p.published_at >= ?
            AND (? IS NULL OR COALESCE(p.channel, 'main') = ?)
          GROUP BY s.post_id`,
        sinceIso,
        channel ?? null,
        channel ?? null,
      );
      if (rows.length === 0) return { average: 0, counted: 0 };
      const total = rows.reduce((sum, row) => sum + row.views, 0);
      const best = rows.reduce((top, row) => (row.views > top.views ? row : top), rows[0]!);
      return {
        average: Math.round(total / rows.length),
        best: { postId: best.post_id, views: best.views },
        counted: rows.length,
      };
    },

    missed(postId) {
      const at = now().toISOString();
      db.run(
        `INSERT INTO withdraw_watch (post_id, misses, updated_at) VALUES (?, 1, ?)
         ON CONFLICT (post_id) DO UPDATE SET misses = misses + 1, updated_at = excluded.updated_at`,
        postId,
        at,
      );
      const row = db.get<{ misses: number }>('SELECT misses FROM withdraw_watch WHERE post_id = ?', postId);
      return row?.misses ?? 0;
    },

    seen(postId) {
      db.run('DELETE FROM withdraw_watch WHERE post_id = ?', postId);
    },
  };
}

/**
 * Выборки для статистики (тикет 11). Живут в репозитории, а не в `src/stats`:
 * правило «SQL только в store» держит отчёт чистой функцией над данными.
 */
export interface StatsRepo {
  /**
   * Сколько вышло. С каналом — публикации в этом канале (копии «в оба»
   * считаются своему каналу); без канала — уникальные посты, без копий.
   */
  countPublished(options?: { sinceIso?: string; platform?: string; channel?: ChannelKey }): number;
  countByStatus(statuses: readonly string[]): number;
  /** Сколько постов каждой рубрики вышло с момента. */
  rubricCounts(sinceIso: string): { rubric: string; count: number }[];
  /** Сколько постов с каким уровнем рекламы вышло с момента. */
  ctaCounts(sinceIso: string): { cta: string; count: number }[];
  /**
   * Средняя оценка редактора отдельно у вышедших и у похороненных постов.
   * Это калибровка: если снятые владельцем посты редактор хвалил, спорят не
   * владелец с редактором, а редактор с читателем.
   */
  judgeMeans(limit?: number): { published: number | null; rejected: number | null };
}

export function createStatsRepo(db: Db): StatsRepo {
  return {
    countPublished(options = {}) {
      const where: string[] = ["status IN ('published', 'withdrawn', 'posted')"];
      const params: SqlValue[] = [];
      if (options.channel !== undefined) {
        where.push("platform = 'telegram' AND COALESCE(channel, 'main') = ?");
        params.push(options.channel);
      } else {
        where.push(NOT_CHANNEL_COPY_SQL);
      }
      if (options.platform !== undefined) {
        where.push('platform = ?');
        params.push(options.platform);
      }
      if (options.sinceIso !== undefined) {
        where.push('published_at IS NOT NULL AND published_at >= ?');
        params.push(options.sinceIso);
      }
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM posts WHERE ${where.join(' AND ')}`,
        ...params,
      );
      return row?.n ?? 0;
    },

    countByStatus(statuses) {
      if (statuses.length === 0) return 0;
      const placeholders = statuses.map(() => '?').join(', ');
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM posts WHERE status IN (${placeholders})`,
        ...statuses,
      );
      return row?.n ?? 0;
    },

    rubricCounts(sinceIso) {
      return db.all<{ rubric: string; count: number }>(
        `SELECT COALESCE(rubric, 'без рубрики') AS rubric, COUNT(*) AS count
           FROM posts
          WHERE status IN ('published', 'withdrawn') AND published_at >= ?
            AND ${NOT_CHANNEL_COPY_SQL}
          GROUP BY rubric
          ORDER BY count DESC`,
        sinceIso,
      );
    },

    ctaCounts(sinceIso) {
      return db.all<{ cta: string; count: number }>(
        `SELECT cta, COUNT(*) AS count
           FROM posts
          WHERE status IN ('published', 'withdrawn') AND published_at >= ?
            AND ${NOT_CHANNEL_COPY_SQL}
          GROUP BY cta`,
        sinceIso,
      );
    },

    judgeMeans(limit = 500) {
      // Оценка лежит в JSON-колонке: разбираем в JS, а не в SQL — сборка
      // SQLite в рантайме не обязана нести расширение JSON1.
      const rows = db.all<{ status: string; judge: string | null }>(
        `SELECT status, judge FROM posts
          WHERE judge IS NOT NULL AND status IN ('published', 'withdrawn', 'rejected')
            AND ${NOT_CHANNEL_COPY_SQL}
          ORDER BY created_at DESC LIMIT ?`,
        limit,
      );
      const buckets: Record<'published' | 'rejected', number[]> = { published: [], rejected: [] };
      for (const row of rows) {
        if (row.judge === null) continue;
        let mean: unknown;
        try {
          mean = (JSON.parse(row.judge) as { mean?: unknown }).mean;
        } catch {
          // Негодный JSON в колонке — это симптом ручной правки базы, но
          // ронять отчёт из-за одной строки незачем: о нём уже сообщает
          // `onCorruptJson` на чтении поста.
          continue;
        }
        if (typeof mean !== 'number' || !Number.isFinite(mean)) continue;
        if (row.status === 'published') buckets.published.push(mean);
        else buckets.rejected.push(mean);
      }
      const average = (values: number[]): number | null =>
        values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
      return { published: average(buckets.published), rejected: average(buckets.rejected) };
    },
  };
}
