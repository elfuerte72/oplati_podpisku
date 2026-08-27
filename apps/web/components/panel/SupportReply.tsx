'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import {
  ACTION_TITLES,
  FALLBACK_ERROR_TEXT,
  SUPPORT_ERROR_TEXT,
  SUPPORT_NOT_RECORDED_TEXT,
} from '@/lib/panel/labels';
import { SUPPORT_REPLY_MAX, SUPPORT_REPLY_MIN } from '@/lib/panel/support';

import { markPanelBusy } from './LiveRefresh';

/**
 * Ответ клиенту и кнопка «подключиться к диалогу» (тикет 10).
 *
 * ⚠️ Ответ уходит клиенту ОТ БОТА. Подписи оператора в тексте нет и быть не
 * должно: клиент не знает, что за ботом человек.
 */

function errorText(code: string | undefined): string {
  return lookupLabel(SUPPORT_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT;
}

export function SupportReply({
  conversationId,
  needsAssign,
}: {
  conversationId: string;
  needsAssign: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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

  async function assign() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const { ok, data } = await post('/api/panel/support/assign', { conversationId });
      if (!ok) {
        setError(errorText((data as { error?: string } | null)?.error));
        return;
      }
      router.refresh();
    } catch {
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  async function reply(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const releaseBusy = markPanelBusy();
    try {
      const { ok, data } = await post('/api/panel/support/reply', { conversationId, text });
      if (!ok) {
        setError(errorText((data as { error?: string } | null)?.error));
        return;
      }
      // Доставлено, но в переписку не записалось: следующий менеджер ответа не
      // увидит. Молчать об этом нельзя.
      if ((data as { warning?: string } | null)?.warning === 'not_recorded') {
        setNote(SUPPORT_NOT_RECORDED_TEXT);
      }
      setText('');
      router.refresh();
    } catch {
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  return (
    <>
      {needsAssign ? (
        <p className="panel-muted" style={{ marginBottom: 8 }}>
          Диалог свободен. Подключитесь, чтобы коллеги видели, что им занимаются.{' '}
          <button type="button" className="panel-button" onClick={assign} disabled={busy}>
            {ACTION_TITLES.assign}
          </button>
        </p>
      ) : null}

      <form onSubmit={reply}>
        <textarea
          className="panel-input"
          style={{ display: 'block', width: '100%', minHeight: 96 }}
          value={text}
          minLength={SUPPORT_REPLY_MIN}
          maxLength={SUPPORT_REPLY_MAX}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ответ уйдёт клиенту от имени бота"
          required
        />
        {error ? (
          <p className="panel-error" style={{ marginTop: 8 }}>
            {error}
          </p>
        ) : null}
        {note ? (
          <p className="panel-error" style={{ marginTop: 8 }}>
            {note}
          </p>
        ) : null}
        <button type="submit" className="panel-button" style={{ marginTop: 8 }} disabled={busy}>
          {busy ? ACTION_TITLES.sending : ACTION_TITLES.reply}
        </button>
      </form>
    </>
  );
}
