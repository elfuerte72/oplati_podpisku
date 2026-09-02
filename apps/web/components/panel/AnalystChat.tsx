'use client';

import { useState, type SubmitEvent } from 'react';

import {
  applyAskResponse,
  buildAskBody,
  EMPTY_CHAT,
  type AnalystToolCall,
  type ChatState,
} from '@/lib/panel/ai/chat-state';
import { lookupLabel } from '@/lib/panel/format';
import { ANALYST_ERROR_TEXT, ANALYST_TEXT, FALLBACK_ERROR_TEXT } from '@/lib/panel/labels';

import { markPanelBusy } from './LiveRefresh';

/**
 * Чат с аналитиком (панель v2, тикет 07). Лента живёт в памяти компонента —
 * перезагрузка страницы её очищает, и это намеренно (Q11 спеки: эфемерно).
 * История уходит с каждым запросом целиком; решения о теле запроса и о
 * применении ответа — в `lib/panel/ai/chat-state.ts`.
 *
 * Ответ модели — plain text с сохранением переводов строк; Markdown не
 * парсится (как в Telegram-ответах помощника).
 */
export function AnalystChat() {
  const [chat, setChat] = useState<ChatState>(EMPTY_CHAT);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  async function ask(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || question.trim().length === 0) return;
    setBusy(true);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildAskBody(chat, question)),
      });
      const data: unknown = await res.json().catch(() => null);
      const next = applyAskResponse(chat, question, { ok: res.ok, data });
      setChat(next);
      // Поле очищается только после успеха: после отказа вопрос остаётся,
      // чтобы поправить и повторить.
      if (next.error === null) setQuestion('');
    } catch {
      setChat({ ...chat, error: 'unavailable', failedToolCalls: [] });
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  const errorText = chat.error ? (lookupLabel(ANALYST_ERROR_TEXT, chat.error) ?? FALLBACK_ERROR_TEXT) : null;

  return (
    <div className="panel-analyst">
      {chat.turns.length > 0 ? (
        <ol className="panel-thread panel-analyst__thread">
          {chat.turns.map((turn, i) => (
            <li
              key={i}
              className={`panel-thread__item panel-thread__item--${turn.role === 'user' ? 'user' : 'assistant'}`}
            >
              <div className="panel-muted" style={{ fontSize: 12 }}>
                {turn.role === 'user' ? ANALYST_TEXT.you : ANALYST_TEXT.analyst}
              </div>
              <div className="panel-analyst__text">{turn.text}</div>
              {turn.incomplete ? <div className="panel-muted">{ANALYST_TEXT.incomplete}</div> : null}
              {turn.toolCalls && turn.toolCalls.length > 0 ? (
                <ToolCalls calls={turn.toolCalls} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <form onSubmit={ask} className="panel-analyst__form">
        <textarea
          className="panel-input"
          style={{ display: 'block', width: '100%', minHeight: 80 }}
          value={question}
          maxLength={2000}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={ANALYST_TEXT.placeholder}
          disabled={busy}
          required
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="panel-button" disabled={busy}>
            {busy ? ANALYST_TEXT.thinking : ANALYST_TEXT.ask}
          </button>
          {chat.turns.length > 0 ? (
            <button
              type="button"
              className="panel-button panel-button--secondary"
              onClick={() => setChat(EMPTY_CHAT)}
              disabled={busy}
            >
              {ANALYST_TEXT.clear}
            </button>
          ) : null}
        </div>
      </form>

      {errorText ? (
        <div className="panel-error" style={{ marginTop: 8 }}>
          {errorText}
        </div>
      ) : null}
      {chat.failedToolCalls.length > 0 ? <ToolCalls calls={chat.failedToolCalls} /> : null}
    </div>
  );
}

/** Раскрывающиеся блоки «SQL → таблица» под ответом. */
function ToolCalls({ calls }: { calls: AnalystToolCall[] }) {
  return (
    <div className="panel-analyst__calls">
      {calls.map((call, i) => (
        <details key={i} className="panel-analyst__call">
          <summary>
            {ANALYST_TEXT.executedQuery} {calls.length > 1 ? `${i + 1}/${calls.length}` : ''}
            {call.error ? ` · ${ANALYST_TEXT.queryFailed}` : ` · ${call.rows.length}`}
          </summary>
          <pre className="panel-analyst__sql">{call.sql}</pre>
          {call.error ? (
            <div className="panel-error">{call.error}</div>
          ) : call.rows.length === 0 ? (
            <p className="panel-muted">{ANALYST_TEXT.noRows}</p>
          ) : (
            <div className="panel-table-scroll">
              <table className="panel-table">
                <thead>
                  <tr>
                    {call.columns.map((c, ci) => (
                      <th key={ci}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {call.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{cellText(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {call.truncated ? <p className="panel-muted">{ANALYST_TEXT.truncated}</p> : null}
        </details>
      ))}
    </div>
  );
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '—';
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}
