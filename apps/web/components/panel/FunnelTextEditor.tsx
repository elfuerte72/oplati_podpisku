'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import { FALLBACK_ERROR_TEXT, FUNNEL_TEXTS_TEXT, FUNNEL_TEXT_ERROR_TEXT } from '@/lib/panel/labels';

import { markPanelBusy } from './LiveRefresh';

/**
 * Форма правки одного текста воронки (панель v2, тикеты 11–12): textarea со
 * счётчиком, «Сохранить», «Вернуть по умолчанию» (только у изменённых) и
 * «Отправить мне» — уходит ТЕКУЩЕЕ содержимое поля, несохранённое, чтобы
 * увидеть формулировку глазами клиента до сохранения.
 *
 * Решение «валиден ли текст» принимает сервер (одна валидация на сохранение и
 * тест-отправку); здесь — только показ причины по словарю.
 */

type Props = {
  textKey: string;
  value: string;
  isOverridden: boolean;
  maxLength: number;
  /** Однострочная подпись кнопки — компактное поле вместо textarea. */
  singleLine: boolean;
};

/** Текст отказа: причина по словарю + деталь (имя подстановки или лимит). */
function errorText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return FALLBACK_ERROR_TEXT;
  const body = data as { error?: unknown; placeholder?: unknown; max?: unknown };
  const code = typeof body.error === 'string' ? body.error : undefined;
  const base = lookupLabel(FUNNEL_TEXT_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT;
  if (typeof body.placeholder === 'string') return `${base} {${body.placeholder}}`;
  if (typeof body.max === 'number') return `${base} ${body.max}`;
  return base;
}

export function FunnelTextEditor({ textKey, value, isOverridden, maxLength, singleLine }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function post(url: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => null);
    return { ok: res.ok, data };
  }

  async function run(kind: 'save' | 'reset' | 'test', url: string, body: unknown, onOk: () => void) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNote(null);
    const releaseBusy = markPanelBusy();
    try {
      const { ok, data } = await post(url, body);
      if (!ok) {
        setError(errorText(data));
        return;
      }
      onOk();
    } catch {
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(null);
      releaseBusy();
    }
  }

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim() === value.trim() && isOverridden) {
      setNote(FUNNEL_TEXTS_TEXT.unchanged);
      return;
    }
    void run('save', '/api/panel/texts/save', { key: textKey, value: draft }, () => {
      setNote(FUNNEL_TEXTS_TEXT.saved);
      router.refresh();
    });
  }

  function reset() {
    void run('reset', '/api/panel/texts/reset', { key: textKey }, () => {
      setNote(FUNNEL_TEXTS_TEXT.resetDone);
      router.refresh();
    });
  }

  function testSend() {
    void run('test', '/api/panel/texts/test-send', { key: textKey, value: draft }, () => {
      setNote(FUNNEL_TEXTS_TEXT.testSent);
    });
  }

  const inputStyle = { display: 'block', width: '100%' } as const;

  return (
    <form onSubmit={save} className="panel-text-editor">
      {singleLine ? (
        <input
          className="panel-input"
          style={inputStyle}
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy !== null}
          required
        />
      ) : (
        <textarea
          className="panel-input"
          style={{ ...inputStyle, minHeight: 96 }}
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy !== null}
          required
        />
      )}
      <div className="panel-text-editor__bar">
        <span className="panel-muted panel-text-editor__count">
          {draft.length} / {maxLength}
        </span>
        <button type="submit" className="panel-button" disabled={busy !== null}>
          {busy === 'save' ? FUNNEL_TEXTS_TEXT.saving : FUNNEL_TEXTS_TEXT.save}
        </button>
        <button
          type="button"
          className="panel-button panel-button--secondary"
          onClick={testSend}
          disabled={busy !== null}
          title={FUNNEL_TEXTS_TEXT.testSendHint}
        >
          {busy === 'test' ? FUNNEL_TEXTS_TEXT.testSending : FUNNEL_TEXTS_TEXT.testSend}
        </button>
        {isOverridden ? (
          <button
            type="button"
            className="panel-button panel-button--secondary"
            onClick={reset}
            disabled={busy !== null}
          >
            {FUNNEL_TEXTS_TEXT.reset}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="panel-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      {note ? (
        <div className="panel-muted" style={{ marginTop: 8 }}>
          {note}
        </div>
      ) : null}
    </form>
  );
}
