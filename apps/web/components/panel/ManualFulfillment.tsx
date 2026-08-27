'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  MANUAL_FULFILLMENT_COMMENT_MAX,
  MANUAL_FULFILLMENT_COMMENT_MIN,
  type ManualFulfillmentAction,
} from '@/lib/panel/fulfillment';
import { lookupLabel } from '@/lib/panel/format';
import { ACTION_TITLES, FALLBACK_ERROR_TEXT, FULFILLMENT_ERROR_TEXT } from '@/lib/panel/labels';

import { markPanelBusy } from './LiveRefresh';

/**
 * Кнопки ручного исполнения заказа (тикет 06).
 *
 * Показываются ТОЛЬКО в подходящем статусе — решение принимает страница, а не
 * этот компонент: она уже знает статус заказа и не должна отдавать в браузер
 * разметку действия, которое всё равно отвергнет сервер.
 *
 * На время запроса на `<body>` вешается `data-panel-busy` — это тот самый
 * признак, по которому живое обновление не перерисовывает экран посреди
 * действия (`LiveRefresh`).
 */

export function ManualFulfillment({
  shortId,
  action,
}: {
  shortId: string;
  action: ManualFulfillmentAction;
}) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/orders/fulfillment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shortId,
          action,
          ...(action === 'start' ? { comment } : {}),
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (data as { error?: string } | null)?.error;
        // Код приходит из тела ответа, то есть снаружи, — читаем словарь только
        // через `lookupLabel` (защита от ключей прототипа живёт в одном месте).
        setError(lookupLabel(FULFILLMENT_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT);
        return;
      }
      setComment('');
      router.refresh();
    } catch {
      // Сеть отвалилась. Молчать нельзя: человек должен знать, что заказ НЕ
      // переведён, иначе он решит, что выдача записана, и уйдёт.
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      {action === 'start' ? (
        <>
          <label htmlFor="fulfillment-comment" className="panel-muted">
            Что выдали вручную (обязательно)
          </label>
          <textarea
            id="fulfillment-comment"
            className="panel-input"
            style={{ display: 'block', width: '100%', marginTop: 6, minHeight: 64 }}
            value={comment}
            minLength={MANUAL_FULFILLMENT_COMMENT_MIN}
            maxLength={MANUAL_FULFILLMENT_COMMENT_MAX}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Например: карту пополнили вручную, реквизиты отправили в Telegram"
            required
          />
        </>
      ) : null}

      {error ? (
        <p className="panel-error" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}

      <button type="submit" className="panel-button" style={{ marginTop: 8 }} disabled={busy}>
        {action === 'start' ? ACTION_TITLES.fulfillmentStart : ACTION_TITLES.fulfillmentComplete}
      </button>
    </form>
  );
}
