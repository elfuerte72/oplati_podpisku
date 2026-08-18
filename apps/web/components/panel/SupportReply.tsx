'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { SUPPORT_REPLY_MAX, SUPPORT_REPLY_MIN } from '@/lib/panel/support';

import { markPanelBusy } from './LiveRefresh';

/**
 * Ответ клиенту и кнопка «подключиться к диалогу» (тикет 10).
 *
 * ⚠️ Ответ уходит клиенту ОТ БОТА. Подписи оператора в тексте нет и быть не
 * должно: клиент не знает, что за ботом человек.
 */

const FALLBACK_ERROR = 'Не получилось. Обнови страницу и попробуй ещё раз.';

const ERROR_TEXT: Record<string, string> = {
  no_telegram: 'У клиента нет Telegram — ответить нечем.',
  assigned_to_other: 'Диалог уже ведёт другой сотрудник.',
  send_failed: 'Telegram не принял сообщение — скорее всего, клиент заблокировал бота.',
  not_found: 'Диалог не найден.',
  invalid_body: 'Слишком короткий или слишком длинный ответ.',
  forbidden: 'Твоей роли этот раздел закрыт (или доступ отключили).',
  unauthorized: 'Сессия истекла — войди заново.',
};

function errorText(code: string | undefined): string {
  // `Object.hasOwn`: код приходит из тела ответа, то есть снаружи.
  return (code && Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : undefined) ?? FALLBACK_ERROR;
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
      setError(FALLBACK_ERROR);
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
        setNote('Клиенту отправлено, но в переписку не записалось — предупреди коллег.');
      }
      setText('');
      router.refresh();
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  return (
    <>
      {needsAssign ? (
        <p className="panel-muted" style={{ marginBottom: 8 }}>
          Диалог свободен. Подключись, чтобы коллеги видели, что им занимаются.{' '}
          <button type="button" className="panel-button" onClick={assign} disabled={busy}>
            Подключиться
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
          {busy ? 'Отправляем…' : 'Отправить'}
        </button>
      </form>
    </>
  );
}
