'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import { ACTION_TITLES, FALLBACK_ERROR_TEXT, REMIND_ERROR_TEXT } from '@/lib/panel/labels';

import { markPanelBusy } from './LiveRefresh';

/**
 * Кнопка «напомнить об оплате» (тикет 07).
 *
 * Рисуется ТОЛЬКО там, где напоминать можно: решение принимает страница — она
 * уже знает и статус заказа, и срок счёта, и достижимость клиента. Кнопка,
 * которая молча ничего не делает, хуже её отсутствия.
 *
 * На время запроса на `<body>` вешается `data-panel-busy`: живое обновление не
 * перерисовывает экран посреди операции.
 */

export function RemindPayment({ shortId }: { shortId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/orders/remind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shortId }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (data as { error?: string } | null)?.error;
        setError(lookupLabel(REMIND_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      // Сеть отвалилась. Молчать нельзя: менеджер решит, что напомнил.
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  if (done && !error) {
    return <span className="panel-status panel-status--ok">{ACTION_TITLES.sent}</span>;
  }

  return (
    <>
      <button type="button" className="panel-button" onClick={send} disabled={busy}>
        {busy ? ACTION_TITLES.sending : ACTION_TITLES.remind}
      </button>
      {error ? (
        <div className="panel-error" style={{ marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
