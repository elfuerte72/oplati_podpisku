'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  MANUAL_FULFILLMENT_COMMENT_MAX,
  MANUAL_FULFILLMENT_COMMENT_MIN,
  type ManualFulfillmentAction,
} from '@/lib/panel/fulfillment';

import { PANEL_BUSY_ATTRIBUTE } from './LiveRefresh';

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

const ERROR_TEXT: Record<string, string> = {
  comment_required: 'Опиши, что именно выдали — одной строки достаточно.',
  wrong_status: 'Статус заказа изменился. Обнови страницу и посмотри, что с ним стало.',
  not_found: 'Заказ не найден.',
  forbidden: 'Раздел доступен только владельцу.',
  unauthorized: 'Сессия истекла — войди заново.',
  unavailable: 'Не получилось: что-то на нашей стороне. Попробуй через минуту.',
};

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
    document.body.setAttribute(PANEL_BUSY_ATTRIBUTE, '1');
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
        const code = (data as { error?: string } | null)?.error ?? 'unavailable';
        setError(ERROR_TEXT[code] ?? ERROR_TEXT.unavailable!);
        return;
      }
      setComment('');
      router.refresh();
    } catch {
      // Сеть отвалилась. Молчать нельзя: человек должен знать, что заказ НЕ
      // переведён, иначе он решит, что выдача записана, и уйдёт.
      setError(ERROR_TEXT.unavailable!);
    } finally {
      setBusy(false);
      document.body.removeAttribute(PANEL_BUSY_ATTRIBUTE);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      {action === 'start' ? (
        <>
          <label htmlFor="fulfillment-comment" className="panel-muted">
            Что выдали руками (обязательно)
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
        {action === 'start' ? 'Беру в ручную выдачу' : 'Выдал'}
      </button>
    </form>
  );
}
