import * as Sentry from '@sentry/nextjs';

import {
  runReadOnlyQuery,
  stripTrailingSemicolons,
  type ReadOnlyExecutor,
  type ReadOnlyQueryResult,
} from '@oplati/db';
import { runSqlInput } from '@oplati/types';

import type { AgentProfile, ToolExecution } from '@oplati/agent';

import { childLogger } from '@/lib/logger';
import { maskForModel } from '@/lib/support/mask';

/**
 * `run_sql` — единственный инструмент AI-аналитика панели (спека
 * admin-panel-v2, ветка B, тикет 05).
 *
 * Страховки ПОВЕРХ роли `panel_ai_ro` и read-only транзакции исполнителя
 * (`runReadOnlyQuery`): начинается с SELECT/WITH, без `SELECT INTO`,
 * блокировок строк и функций ожидания; «ровно одно выражение» проверяется и
 * здесь (понятный отказ модели), и сервером — extended protocol исполнителя
 * отвергает `;`-цепочку сам, лексер ниже не эшелон защиты. Отказ уходит модели
 * как ошибка инструмента — она переформулирует, а не получает пустой ответ.
 *
 * Провайдер видит только то, что отдаёт роль (без email, телефонов, переписки),
 * а строковые ячейки дополнительно проходят `maskForModel` (Q13 спеки):
 * свободный текст вроде `orders.custom_description` может нести контакт,
 * который клиент вписал сам. Идентификаторы (`telegram_id`, `user_id`) не
 * маскируются — аналитик обязан уметь указать на конкретного клиента.
 */

const log = childLogger('panel.ai.sql');

export const RUN_SQL_ROW_LIMIT = 200;
export const RUN_SQL_MAX_BYTES = 32_768;
export const RUN_SQL_TIMEOUT_MS = 30_000;

// Тип инструмента — через профиль движка: SDK Anthropic у `apps/web` в
// зависимостях нет и не должно быть, его держит `@oplati/agent`.
export const runSqlTool: AgentProfile['tools'][number] = {
  name: 'run_sql',
  description:
    'Выполняет ОДИН SQL-запрос SELECT (или WITH … SELECT) к копии боевой базы под read-only ролью и возвращает до 200 строк текстом: заголовок колонок и строки через « | ». Изменять данные невозможно. Ошибка SQL возвращается текстом — поправьте запрос и вызовите снова. Используйте только таблицы и колонки из словаря схемы; при сомнении сначала спросите information_schema.columns.',
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'Один SELECT-запрос без завершающей точки с запятой.',
      },
    },
    required: ['sql'],
  },
};

// ─── Валидация ────────────────────────────────────────────────────────────

export type SqlValidation = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Заменить комментарии и содержимое строковых литералов пробелами, СОХРАНЯЯ
 * длину и позиции: служебные слова ищутся только в коде запроса, а индекс
 * последнего значимого символа переносится на исходный текст — так хвостовые
 * `;` снимаются вместе с комментарием ПОСЛЕ них (`SELECT 1; -- итого`).
 * Литерал остаётся парой кавычек с пробелами внутри, чтобы `'a;b'` не считался
 * разделителем выражений.
 *
 * Расхождения с лексером Postgres здесь не эшелон защиты — одно выражение
 * форсит сам сервер (extended protocol в `runReadOnlyQuery`), — но два
 * известных учтены (code-review 2026-09-02): `$` внутри идентификатора
 * (`x$a$` — имя, не открывающий тег долларовой строки) и escape-строки
 * `E'\''`, где `\` экранирует следующий символ.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const blank = (n: number) => ' '.repeat(Math.max(0, n));
  // Идентификатор Postgres может быть и не-ASCII (`я$a$` — имя, а не начало
  // долларовой строки), поэтому буквы и цифры любых алфавитов.
  const isIdent = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    const prev = i > 0 ? sql[i - 1] : undefined;
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += blank(end - i);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += blank(end - i);
      i = end;
      continue;
    }
    if (ch === "'") {
      // Стандартная строка: `''` внутри — экранированная кавычка. В E'…'
      // (префикс не часть идентификатора) `\` экранирует следующий символ.
      const escapes = (prev === 'E' || prev === 'e') && !isIdent(i > 1 ? sql[i - 2] : undefined);
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const end = Math.min(j + 1, sql.length);
      const len = end - i;
      out += len >= 2 ? `'${blank(len - 2)}'` : "'";
      i = end;
      continue;
    }
    if (ch === '$' && !isIdent(prev)) {
      // Долларовые строки `$$…$$` и `$tag$…$tag$` — только вне идентификатора.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        out += `'${blank(end - i - 2)}'`;
        i = end;
        continue;
      }
    }
    if (ch === '"') {
      // Идентификатор в кавычках — оставляем как есть, но не заглядываем внутрь.
      const close = sql.indexOf('"', i + 1);
      const end = close === -1 ? sql.length : close + 1;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const FORBIDDEN = [
  { re: /\bINTO\b/i, reason: 'SELECT INTO создаёт таблицу — используйте обычный SELECT' },
  { re: /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/i, reason: 'блокировки строк (FOR UPDATE) запрещены' },
  { re: /\bFOR\s+(KEY\s+)?SHARE\b/i, reason: 'блокировки строк (FOR SHARE) запрещены' },
  { re: /\bpg_sleep(_for|_until)?\b/i, reason: 'функции ожидания (pg_sleep*) запрещены' },
  { re: /\bCOPY\b/i, reason: 'COPY запрещён' },
  { re: /\bLOCK\b/i, reason: 'LOCK запрещён' },
  { re: /\bpg_(read_|ls_|stat_file)/i, reason: 'доступ к файлам сервера запрещён' },
  { re: /\b(lo_[a-z]+|lowrite|loread)\b/i, reason: 'large objects запрещены' },
] as const;

/**
 * Проверка запроса ДО исполнения. Возвращает текст без хвостовых `;` и
 * комментариев после них: позиция последнего значимого символа берётся по
 * очищенному коду той же длины, поэтому `SELECT 1; -- итого` → `SELECT 1`, а не
 * `SELECT 1; -- итого` с `;`, о который споткнётся обёртка-подзапрос.
 */
export function validateReadOnlySql(raw: string): SqlValidation {
  const code = stripSqlLiteralsAndComments(raw);
  const end = stripTrailingSemicolons(code).length;
  const codeNoTail = code.slice(0, end).trim();
  const sql = raw.slice(0, end).trim();
  if (codeNoTail.length === 0) return { ok: false, reason: 'пустой запрос' };
  if (codeNoTail.includes(';')) {
    return { ok: false, reason: 'разрешено ровно одно выражение: уберите «;» между запросами' };
  }
  const firstWord = /^\(*\s*([A-Za-z]+)/.exec(codeNoTail)?.[1]?.toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'разрешены только SELECT и WITH … SELECT' };
  }
  for (const rule of FORBIDDEN) {
    if (rule.re.test(codeNoTail)) return { ok: false, reason: rule.reason };
  }
  return { ok: true, sql };
}

// ─── Маскирование и формат ────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Одна строковая ячейка через `maskForModel`.
 *
 * Идентификаторы — не PII и обязаны доехать до модели целыми: uuid (`id`,
 * `user_id`, `order_id`) вынимаются до маски и возвращаются после — иначе
 * телефонный шаблон видит в хвосте `…-4000-8000-000000000001` номер; ячейка из
 * одних цифр (`telegram_id`, суммы текстом) не маскируется вовсе — у роли нет
 * колонок с телефонами, а свободный текст из одних цифр — это число.
 */
export function maskCell(cell: string): string {
  if (/^\d+$/.test(cell)) return cell;
  const ids: string[] = [];
  const withoutIds = cell.replace(UUID_RE, (m) => {
    ids.push(m);
    return `\u0000U${ids.length - 1}\u0000`;
  });
  return maskForModel(withoutIds).replace(/\u0000U(\d+)\u0000/g, (_, i: string) => ids[Number(i)] ?? '');
}

/**
 * Строковые ячейки — через `maskCell`; jsonb (`orders.parameters`,
 * `order_events.payload`, `props` вьюх) — сериализуется и маскируется как
 * строка: внутри свободный текст, и `accountEmail` в параметрах заказа
 * существует по схеме типов. Числа, даты, null не трогаются.
 */
export function maskResultRows(rows: readonly unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === 'string') return maskCell(cell);
      if (typeof cell === 'object' && cell !== null) return maskCell(JSON.stringify(cell));
      return cell;
    }),
  );
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return 'NULL';
  if (typeof cell === 'string') return cell.replace(/\s*\n\s*/g, ' ');
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

/** Компактный текст результата для модели: заголовок, строки через « | », итог. */
export function formatResultForModel(input: {
  columns: readonly string[];
  rows: readonly unknown[][];
  truncated: boolean;
}): string {
  const lines = [input.columns.join(' | ')];
  for (const row of input.rows) lines.push(row.map(cellText).join(' | '));
  lines.push(`rows: ${input.rows.length}${input.truncated ? ' (truncated)' : ''}`);
  return lines.join('\n');
}

// ─── Исполнение ───────────────────────────────────────────────────────────

/** Класс отказа вызова: чем он вызван, а не только текст. */
export type RunSqlErrorReason = 'validation' | Extract<ReadOnlyQueryResult, { ok: false }>['reason'];

/** Сырой результат вызова — для экрана (раскрывашка «SQL → таблица»). */
export type RunSqlView = {
  sql: string;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  /** Сообщение для модели (и для раскрывашки): текст Postgres или причина отказа валидации. */
  error: string | null;
  errorReason: RunSqlErrorReason | null;
};

/** Тексты для МОДЕЛИ (не панели): ей нужно понять, что делать дальше. */
const MODEL_ERROR_TEXT = {
  invalid_input: 'вход инструмента: ожидается { sql: string } до 8000 символов',
  not_configured: 'подключение аналитика не настроено',
  timeout: 'запрос превысил лимит времени — упростите его или сузьте период',
  connection: 'база данных недоступна, попробуйте позже',
} as const;

export type RunSqlOutcome = { execution: ToolExecution; view: RunSqlView };

export type RunSqlDeps = {
  /** Подмена исполнителя — тесты на PGlite. Боевой путь — `PANEL_AI_DATABASE_URL`. */
  executor?: ReadOnlyExecutor;
  query?: (
    sql: string,
    opts: { rowLimit: number; maxBytes: number; timeoutMs: number },
    executor?: ReadOnlyExecutor,
  ) => Promise<ReadOnlyQueryResult>;
};

/**
 * Полный ход инструмента: Zod → валидация → исполнение → маска → текст.
 * Никогда не бросает: любой отказ — `isError: true` с причиной для модели.
 */
export async function executeRunSql(rawInput: unknown, deps: RunSqlDeps = {}): Promise<RunSqlOutcome> {
  const parsed = runSqlInput.safeParse(rawInput);
  if (!parsed.success) {
    const reason = MODEL_ERROR_TEXT.invalid_input;
    return {
      execution: { result: { error: reason }, isError: true },
      view: { sql: '', columns: [], rows: [], truncated: false, error: reason, errorReason: 'validation' },
    };
  }

  const validation = validateReadOnlySql(parsed.data.sql);
  if (!validation.ok) {
    return {
      execution: { result: { error: validation.reason }, isError: true },
      view: {
        sql: parsed.data.sql,
        columns: [],
        rows: [],
        truncated: false,
        error: validation.reason,
        errorReason: 'validation',
      },
    };
  }

  const query = deps.query ?? runReadOnlyQuery;
  const res = await query(
    validation.sql,
    { rowLimit: RUN_SQL_ROW_LIMIT, maxBytes: RUN_SQL_MAX_BYTES, timeoutMs: RUN_SQL_TIMEOUT_MS },
    deps.executor,
  );

  if (!res.ok) {
    // `sql_error` — штатная правка запроса моделью; `timeout` — тяжёлый вопрос;
    // а вот `connection` — упавшая или неверно настроенная база аналитика, и
    // это неожиданный отказ: исполнитель отдаёт Result (он не бросает), Sentry
    // и лог с причиной — здесь, на границе с приложением.
    if (res.reason === 'connection') {
      log.error({ event: 'panel.ai.sql.connection_failed', message: res.message });
      Sentry.captureException(new Error(`panel_ai_ro connection failed: ${res.message}`), {
        tags: { source: 'panel.ai.sql' },
      });
    }
    // Текст Postgres несёт значение ячейки, о которое споткнулся запрос
    // (`invalid input syntax for type integer: "…"`), — свободный текст клиента
    // уходит модели через ту же маску, что и строки результата (security-review
    // 2026-09-02).
    const error =
      res.reason === 'sql_error' ? `ошибка SQL: ${maskCell(res.message)}` : MODEL_ERROR_TEXT[res.reason];
    return {
      execution: { result: { error, reason: res.reason }, isError: true },
      view: { sql: validation.sql, columns: [], rows: [], truncated: false, error, errorReason: res.reason },
    };
  }

  const rows = maskResultRows(res.rows);
  return {
    execution: {
      result: formatResultForModel({ columns: res.columns, rows, truncated: res.truncated }),
      isError: false,
    },
    view: {
      sql: validation.sql,
      columns: res.columns,
      rows,
      truncated: res.truncated,
      error: null,
      errorReason: null,
    },
  };
}
