'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import { ACTION_TITLES, FALLBACK_ERROR_TEXT, PAYOUT_ERROR_TEXT } from '@/lib/panel/labels';

import { markPanelBusy } from './LiveRefresh';

/**
 * Решение по заявке на вывод (тикет 12): «выплачено» и «отклонить».
 *
 * ⚠️ Это РЕАЛЬНЫЕ деньги партнёра, поэтому обе кнопки требуют подтверждения —
 * не диалогом браузера (он блокирует поток и ломает автоматизацию), а вторым
 * нажатием: первое меняет подпись на «Подтвердить …».
 *
 * ⚠️ «Выплачено» НЕ переводит деньги: перевод владелец делает вручную, панель
 * лишь фиксирует факт.
 */

type Action = 'paid' | 'reject';

export function PayoutDecision({
  payoutId,
  suspended = false,
}: {
  payoutId: string;
  suspended?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);

  async function decide(action: Action) {
    if (busy) return;
    // Первое нажатие только подтверждает намерение: деньги партнёра — не то
    // место, где промах мышью должен что-то менять.
    if (confirming !== action) {
      setConfirming(action);
      setError(null);
      return;
    }

    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/partners/payout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payoutId, action }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (data as { error?: string } | null)?.error;
        setError(lookupLabel(PAYOUT_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT);
        return;
      }
      setConfirming(null);
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
      <div style={{ display: 'flex', gap: 8 }}>
        {/* Заблокированному партнёру кнопки «выплачено» нет вовсе: гейт стоит в
            операции, но предлагать действие, которое всегда откажет, незачем.
            «Отклонить» остаётся — это и есть способ закрыть такую заявку. */}
        {suspended ? null : (
          <button
            type="button"
            className="panel-button"
            onClick={() => decide('paid')}
            disabled={busy}
          >
            {confirming === 'paid' ? ACTION_TITLES.payoutPaidConfirm : ACTION_TITLES.payoutPaid}
          </button>
        )}
        <button
          type="button"
          className="panel-button"
          onClick={() => decide('reject')}
          disabled={busy}
        >
          {confirming === 'reject' ? ACTION_TITLES.payoutRejectConfirm : ACTION_TITLES.payoutReject}
        </button>
      </div>
      {error ? (
        <div className="panel-error" style={{ marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
