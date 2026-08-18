'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

const FALLBACK_ERROR = 'Не получилось. Обнови страницу и попробуй ещё раз.';

const ERROR_TEXT: Record<string, string> = {
  too_soon: 'Уже напоминали за последние сутки.',
  no_invoice: 'Счёт не выставлялся — отправлять нечего.',
  invoice_expired: 'Счёт протух — напоминать нечем, клиенту нужно оформить заказ заново.',
  unavailable: 'Что-то на нашей стороне: бот недоступен. Загляни в Sentry.',
  no_telegram: 'У клиента нет Telegram.',
  send_failed: 'Telegram не принял сообщение — скорее всего, клиент заблокировал бота.',
  not_found: 'Заказ уже не в списке недожатых.',
  forbidden: 'Твоей роли этот раздел закрыт (или доступ отключили).',
  unauthorized: 'Сессия истекла — войди заново.',
};

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
        // `Object.hasOwn`: код приходит из тела ответа, то есть снаружи.
        const text = code && Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : undefined;
        setError(text ?? FALLBACK_ERROR);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      // Сеть отвалилась. Молчать нельзя: менеджер решит, что напомнил.
      setError(FALLBACK_ERROR);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  if (done && !error) return <span className="panel-status panel-status--ok">отправлено</span>;

  return (
    <>
      <button type="button" className="panel-button" onClick={send} disabled={busy}>
        {busy ? 'Отправляем…' : 'Напомнить'}
      </button>
      {error ? (
        <div className="panel-error" style={{ marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
