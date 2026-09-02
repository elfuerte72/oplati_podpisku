import * as Sentry from '@sentry/nextjs';

import { runReadOnlyQuery, type ReadOnlyExecutor, type ReadOnlyQueryResult } from '@oplati/db';
import { runSqlInput } from '@oplati/types';

import type { AgentProfile, ToolExecution } from '@oplati/agent';

import { childLogger } from '@/lib/logger';
import { maskForModel } from '@/lib/support/mask';

/**
 * `run_sql` — единственный инструмент AI-аналитика панели (спека
 * admin-panel-v2, ветка B, тикет 05).
 *
 * Страховки ПОВЕРХ роли `panel_ai_ro` и read-only транзакции исполнителя
 * (`runReadOnlyQuery`): ровно одно выражение, начинается с SELECT/WITH,
 * без `SELECT INTO`, блокировок строк и функций ожидания. Отказ уходит модели
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
 * Снять комментарии и содержимое строковых литералов, чтобы искать служебные
 * слова только в коде запроса. Литералы заменяются на пустые `''`, чтобы
 * `'a;b'` внутри строки не считался разделителем выражений.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'") {
      // Стандартная строка; `''` внутри — экранированная кавычка.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      // Долларовые строки `$$…$$` и `$tag$…$tag$`.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        out += "''";
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (ch === '"') {
      // Идентификатор в кавычках — оставляем как есть, но не заглядываем внутрь.
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
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
  { re: /\bpg_sleep\b/i, reason: 'pg_sleep запрещён' },
  { re: /\bCOPY\b/i, reason: 'COPY запрещён' },
  { re: /\bLOCK\b/i, reason: 'LOCK запрещён' },
  { re: /\bpg_(read_|ls_|stat_file)/i, reason: 'доступ к файлам сервера запрещён' },
  { re: /\blo_(import|export|get|put)\b/i, reason: 'large objects запрещены' },
] as const;

/** Проверка запроса ДО исполнения. Возвращает очищенный от завершающего `;` текст. */
export function validateReadOnlySql(raw: string): SqlValidation {
  const code = stripSqlLiteralsAndComments(raw).trim();
  const sql = raw.trim().replace(/;+\s*$/, '');
  const codeNoTail = code.replace(/;+\s*$/, '').trim();
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
    const error = res.reason === 'sql_error' ? `ошибка SQL: ${res.message}` : MODEL_ERROR_TEXT[res.reason];
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
