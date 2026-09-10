'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import { FALLBACK_ERROR_TEXT, PANEL_BONUS_TEXT } from '@/lib/panel/labels';

import { useFlash, useTwoStep } from './form-feedback';
import { markPanelBusy } from './LiveRefresh';
import { PanelNote } from './PanelNote';

/**
 * Кнопка «Вернуть баллы» на карточке заказа (трек referral-balance-spend,
 * тикет 08).
 *
 * Показывается ТОЛЬКО там, где действие осмысленно, — решает страница: она уже
 * знает и статус заказа, и есть ли живое списание, и не должна отдавать в
 * браузер разметку действия, которое сервер отвергнет.
 *
 * Второе нажатие обязательно: действие необратимое и касается денег клиента.
 */

const ERROR_TEXT: Record<string, string> = {
  no_bonus: PANEL_BONUS_TEXT.refundNothing,
  wrong_status: PANEL_BONUS_TEXT.refundFailed,
  forbidden: FALLBACK_ERROR_TEXT,
  unavailable: PANEL_BONUS_TEXT.refundFailed,
};

export function BonusRefund({ shortId }: { shortId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useFlash();
  const confirm = useTwoStep();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!confirm.press()) return;

    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/orders/bonus-refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shortId }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (data as { error?: string } | null)?.error;
        setError(lookupLabel(ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT);
        return;
      }
      // Повтор — не ошибка: состояние ровно то, которого человек добивался.
      const already = (data as { alreadyReleased?: boolean } | null)?.alreadyReleased === true;
      setFlash(already ? PANEL_BONUS_TEXT.refundAlready : PANEL_BONUS_TEXT.refundDone);
      router.refresh();
    } catch {
      // Сеть отвалилась: молчать нельзя — человек решит, что баллы вернули.
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      {error ? <PanelNote kind="error">{error}</PanelNote> : null}
      {flash ? <PanelNote kind="ok">{flash}</PanelNote> : null}
      {/* Обычная кнопка, не заметная: заметное действие на карточке заказа
          одно — ручная выдача. */}
      <button type="submit" className="panel-button" disabled={busy}>
        {busy
          ? PANEL_BONUS_TEXT.refundInProgress
          : confirm.armed
            ? PANEL_BONUS_TEXT.refundConfirm
            : PANEL_BONUS_TEXT.refundButton}
      </button>
    </form>
  );
}
