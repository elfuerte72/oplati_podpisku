import postgres from 'postgres';

/**
 * Исполнитель read-only SQL для AI-аналитика админ-панели (спека
 * `.scratch/admin-panel-v2/`, ветка B, тикет 04).
 *
 * СВОЁ подключение по `PANEL_AI_DATABASE_URL` под ролью `panel_ai_ro`
 * (`scripts/panel-ai-role.sql`), а не `getDb()`: тот — синглтон приложения с
 * правами владельца БД, и перенацелить его на другую роль нельзя. Защита
 * держится тремя эшелонами, каждый независим от остальных:
 *   1. ГРАНТЫ роли — модель физически не может ни изменить данные, ни прочитать
 *      email/телефон/переписку (нет прав, `permission denied`);
 *   2. транзакция `READ ONLY` + `SET LOCAL statement_timeout` здесь — страховка
 *      на случай лишнего гранта или подключения не той ролью (проверяется на
 *      PGlite без роли вовсе);
 *   3. ОДНО выражение форсит сам сервер: запрос уходит extended protocol
 *      (Parse/Bind/Execute), а в нём Postgres отвергает строку из нескольких
 *      команд (`42601 cannot insert multiple commands into a prepared
 *      statement`) — независимо от того, что сумел разобрать наш лексер в
 *      `run-sql.ts`. Simple protocol (`unsafe()` без параметров по умолчанию)
 *      исполнял бы `;`-цепочку целиком, включая `COMMIT; BEGIN READ WRITE`,
 *      и эшелон 2 держался бы только на лексере (code-review 2026-09-02).
 *      Обёртка `SELECT * FROM (…) LIMIT rowLimit + 1` — потолок строк, чтобы
 *      таблица целиком в процесс не тянулась.
 *
 * Никогда не бросает: любой отказ — Result с причиной. Ошибка SQL уходит
 * наружу с текстом Postgres — модели он нужен, чтобы поправить запрос.
 */

export type ReadOnlyQueryOptions = {
  /** Потолок строк результата; `rowLimit + 1` строк → `truncated: true`. */
  rowLimit: number;
  /** Потолок объёма результата (по JSON-сериализации строк). */
  maxBytes: number;
  timeoutMs: number;
};

export type ReadOnlyQueryResult =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated: boolean }
  | {
      ok: false;
      reason: 'not_configured' | 'timeout' | 'sql_error' | 'connection';
      message: string;
    };

/**
 * Шов для тестов и для смены драйвера: исполняет ОДИН запрос внутри read-only
 * транзакции с таймаутом и отдаёт строки массивами. Бросает ошибку драйвера как
 * есть — классифицирует её `runReadOnlyQuery`.
 */
export interface ReadOnlyExecutor {
  run(sqlText: string, timeoutMs: number): Promise<{ columns: string[]; rows: unknown[][] }>;
}

/** Ошибка драйвера с SQLSTATE — и postgres-js, и PGlite кладут его в `code`. */
function sqlStateOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Классы SQLSTATE, которые означают «запрос неверен» (модель поправит):
 * 42 — синтаксис и права, 22 — данные, 25006 — попытка записи в read-only
 * транзакции, 0A — не поддерживается, 2B/2F/3x — прочие ошибки выражения.
 * 57014 — отмена по statement_timeout. Всё остальное — транспорт/подключение.
 */
function classify(err: unknown): Extract<ReadOnlyQueryResult, { ok: false }> {
  const code = sqlStateOf(err);
  const message = messageOf(err);
  if (code === '57014') return { ok: false, reason: 'timeout', message };
  if (code && /^(42|22|0A|2B|2F|3[0-9A-Z]|25006|21|23|44)/.test(code)) {
    return { ok: false, reason: 'sql_error', message };
  }
  return { ok: false, reason: 'connection', message };
}

/** Ячейка результата в форму, пригодную для JSON и для модели. */
function normalizeCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Снять завершающие `;` и пробелы. Циклом, а не регэкспом `/;+\s*$/`: тот
 * полиномиален на длинной серии `;` (CodeQL js/polynomial-redos), а текст
 * приходит от модели.
 */
export function stripTrailingSemicolons(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text.charCodeAt(end - 1);
    // `;`, пробел, таб, перевод строки, возврат каретки.
    if (ch === 0x3b || ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) end -= 1;
    else break;
  }
  return text.slice(0, end);
}

/**
 * Обёртка запроса: подзапрос + потолок строк. Завершающий `;` снимается —
 * внутри скобок он был бы синтаксической ошибкой, а модель его ставит часто.
 */
export function wrapReadOnlyQuery(sqlText: string, rowLimit: number): string {
  const body = stripTrailingSemicolons(sqlText.trim());
  return `SELECT * FROM (\n${body}\n) AS panel_ai_query LIMIT ${Math.max(1, Math.trunc(rowLimit)) + 1}`;
}

// ─── Исполнители ──────────────────────────────────────────────────────────

let _client: ReturnType<typeof postgres> | undefined;

/**
 * `unsafe()` без параметров по умолчанию идёт simple protocol и исполняет
 * несколько команд через `;`. `simple: false` — extended protocol, где сервер
 * сам отвергает вторую команду (эшелон 3 в шапке). В типах драйвера поля нет,
 * в рантайме читается (`'simple' in options`).
 */
const EXTENDED_PROTOCOL: postgres.UnsafeQueryOptions & { simple: boolean } = { simple: false };

/**
 * Боевой исполнитель: postgres-js по `PANEL_AI_DATABASE_URL`, ленивый
 * синглтон. `max: 2` совпадает с `CONNECTION LIMIT 2` роли; `prepare: false`
 * — запросы одноразовые; `connect_timeout: 5` — недоступная база должна
 * отвечать отказом, а не висеть.
 */
function postgresExecutor(url: string): ReadOnlyExecutor {
  _client ??= postgres(url, { max: 2, prepare: false, connect_timeout: 5 });
  const client = _client;
  return {
    async run(sqlText, timeoutMs) {
      return client.begin('read only', async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
        const result = await tx.unsafe(sqlText, [], EXTENDED_PROTOCOL).values();
        return {
          columns: result.columns.map((c) => c.name),
          rows: result as unknown as unknown[][],
        };
      });
    },
  };
}

// ─── Точка входа ──────────────────────────────────────────────────────────

export async function runReadOnlyQuery(
  sqlText: string,
  opts: ReadOnlyQueryOptions,
  executor?: ReadOnlyExecutor,
): Promise<ReadOnlyQueryResult> {
  let exec = executor;
  if (!exec) {
    const url = process.env.PANEL_AI_DATABASE_URL;
    if (!url) {
      return {
        ok: false,
        reason: 'not_configured',
        message: 'PANEL_AI_DATABASE_URL is not set',
      };
    }
    exec = postgresExecutor(url);
  }

  const rowLimit = Math.max(1, Math.trunc(opts.rowLimit));
  let raw: { columns: string[]; rows: unknown[][] };
  try {
    raw = await exec.run(wrapReadOnlyQuery(sqlText, rowLimit), opts.timeoutMs);
  } catch (err) {
    return classify(err);
  }

  // Потолок строк — по `rowLimit + 1` из обёртки; потолок байт — по
  // сериализации строк: длинная текстовая колонка режет результат раньше.
  let truncated = raw.rows.length > rowLimit;
  const rows: unknown[][] = [];
  let bytes = 0;
  for (const row of raw.rows.slice(0, rowLimit)) {
    const normalized = row.map(normalizeCell);
    bytes += JSON.stringify(normalized).length + 1;
    if (bytes > opts.maxBytes && rows.length > 0) {
      truncated = true;
      break;
    }
    rows.push(normalized);
    if (bytes > opts.maxBytes) {
      // Первая же строка не влезла: отдаём её одну и честно помечаем.
      truncated = raw.rows.length > 1 || truncated;
      break;
    }
  }

  return { ok: true, columns: raw.columns, rows, truncated };
}
