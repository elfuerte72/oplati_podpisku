/**
 * Состояние чата с аналитиком — чистые функции без React (панель v2, тикет 07).
 *
 * Компонент `AnalystChat` только рисует и зовёт `fetch`; решения «что уходит в
 * запрос» и «что стало с лентой после ответа» живут здесь и проверяются тестом
 * без DOM. Чат эфемерный: всё состояние — в памяти вкладки.
 *
 * ⚠️ Модуль едет в клиентский бандл: ни Next, ни env, ни БД, ни zod.
 */

export type AnalystToolCall = {
  sql: string;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  error: string | null;
};

export type ChatTurn = {
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: AnalystToolCall[];
  incomplete?: boolean;
};

export type ChatState = {
  turns: ChatTurn[];
  /** Код ошибки последнего запроса (ключ словаря) или `null`. */
  error: string | null;
  /** Запросы к базе, выполненные до отказа, — их стоит показать и при ошибке. */
  failedToolCalls: AnalystToolCall[];
};

export const EMPTY_CHAT: ChatState = { turns: [], error: null, failedToolCalls: [] };

/** Сколько ходов истории уезжает в запрос — зеркало потолка Zod на сервере. */
export const CHAT_HISTORY_MAX_TURNS = 20;

/**
 * Тело запроса: история целиком (только роль и текст — без таблиц, они
 * серверу не нужны) и новый вопрос. Длинная история режется с начала: сервер
 * принимает не больше 20 ходов, и старые ходы менее ценны, чем свежие.
 */
export function buildAskBody(
  state: ChatState,
  question: string,
): { question: string; history: { role: 'user' | 'assistant'; text: string }[] } {
  const history = state.turns
    .map((t) => ({ role: t.role, text: t.text }))
    .slice(-CHAT_HISTORY_MAX_TURNS);
  return { question: question.trim(), history };
}

function readToolCalls(data: unknown): AnalystToolCall[] {
  if (typeof data !== 'object' || data === null) return [];
  const raw = (data as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      sql: typeof c.sql === 'string' ? c.sql : '',
      columns: Array.isArray(c.columns) ? c.columns.map(String) : [],
      rows: Array.isArray(c.rows) ? c.rows.filter((r): r is unknown[] => Array.isArray(r)) : [],
      truncated: c.truncated === true,
      error: typeof c.error === 'string' ? c.error : null,
    }));
}

/**
 * Что стало с лентой после ответа сервера.
 *
 * Успех — два новых хода (вопрос и ответ с запросами). Отказ — лента не
 * меняется: вопрос остаётся в поле ввода, чтобы поправить и повторить; код
 * ошибки и выполненные до отказа запросы — рядом с полем.
 */
export function applyAskResponse(
  state: ChatState,
  question: string,
  response: { ok: boolean; data: unknown },
): ChatState {
  const data = response.data;
  const okFlag =
    typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === true;
  if (!response.ok || !okFlag) {
    const code =
      typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
        ? ((data as { error: string }).error)
        : 'unavailable';
    return { turns: state.turns, error: code, failedToolCalls: readToolCalls(data) };
  }
  const answer = (data as { answer?: unknown }).answer;
  return {
    turns: [
      ...state.turns,
      { role: 'user', text: question.trim() },
      {
        role: 'assistant',
        text: typeof answer === 'string' ? answer : '',
        toolCalls: readToolCalls(data),
        incomplete: (data as { incomplete?: unknown }).incomplete === true,
      },
    ],
    error: null,
    failedToolCalls: [],
  };
}
