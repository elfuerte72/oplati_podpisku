import type { ZodType } from 'zod';

import type { Db } from './db.ts';
import type { OnCorruptJson } from './posts.ts';
import type { FlowRow, Item, NewItem, UsageByRole, UsageInput, UsageSummary } from './types.ts';
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
  listRecent(options?: { sinceIso?: string; limit?: number; onlyUnjudged?: boolean }): Item[];
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
  };
}

export function createItemsRepo(db: Db, now: () => Date): ItemsRepo {
  const repo: ItemsRepo = {
    upsertByUrl(item) {
      const at = now().toISOString();
      db.run(
        `INSERT INTO items (id, source_kind, source_ref, url, title, published_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET
           title = COALESCE(excluded.title, items.title),
           published_at = COALESCE(excluded.published_at, items.published_at),
           seen_at = excluded.seen_at`,
        ulid(now().getTime()),
        item.sourceKind,
        item.sourceRef ?? null,
        item.url,
        item.title ?? null,
        item.publishedAt ?? null,
        at,
      );
      const stored = repo.findByUrl(item.url);
      if (stored === undefined) throw new Error(`элемент ${item.url} не записался`);
      return stored;
    },
    findByUrl(url) {
      const row = db.get<ItemDbRow>('SELECT * FROM items WHERE url = ?', url);
      return row === undefined ? undefined : toItem(row);
    },
    listRecent(options = {}) {
      const rows = db.all<ItemDbRow>(
        `SELECT * FROM items
          WHERE (? IS NULL OR seen_at >= ?)
            AND (? = 0 OR verdict IS NULL)
          ORDER BY COALESCE(published_at, seen_at) DESC, id DESC
          LIMIT ?`,
        options.sinceIso ?? null,
        options.sinceIso ?? null,
        options.onlyUnjudged === true ? 1 : 0,
        options.limit ?? 50,
      );
      return rows.map(toItem);
    },
    markVerdict(id, verdict) {
      return db.run('UPDATE items SET verdict = ? WHERE id = ?', verdict, id).changes > 0;
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
