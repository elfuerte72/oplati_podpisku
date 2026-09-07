'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import { ACTION_TITLES, FALLBACK_ERROR_TEXT, REMIND_ERROR_TEXT } from '@/lib/panel/labels';

import { useTwoStep } from './form-feedback';
import { markPanelBusy } from './LiveRefresh';
import { PanelNote } from './PanelNote';

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
  const confirm = useTwoStep();

  async function send() {
    if (busy) return;
    // Первое нажатие только взводит кнопку — наружу ничего не уходит.
    if (!confirm.press()) return;
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
    // Кнопки больше нет: окно суток занято, и до перерисовки строки сервером
    // повторное нажатие всё равно получило бы отказ. Остаётся тихая строка —
    // тот же отклик, что у остальных форм панели.
    return <PanelNote kind="ok">{ACTION_TITLES.sent}</PanelNote>;
  }

  return (
    <>
      {/*
       * Двухшаговая: первое нажатие взводит, второе отправляет. Кнопка стоит В
       * СТРОКЕ списка из полусотни заказов, и промах строкой означал платёжный
       * документ чужому клиенту плюс потраченное на него суточное окно.
       */}
      <button type="button" className="panel-button" onClick={send} disabled={busy}>
        {busy
          ? ACTION_TITLES.sending
          : confirm.armed
            ? ACTION_TITLES.remindConfirm
            : ACTION_TITLES.remind}
      </button>
      {error ? <PanelNote kind="error">{error}</PanelNote> : null}
    </>
  );
}
