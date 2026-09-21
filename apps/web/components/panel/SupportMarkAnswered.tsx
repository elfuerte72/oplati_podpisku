'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { lookupLabel } from '@/lib/panel/format';
import {
  ACTION_TITLES,
  FALLBACK_ERROR_TEXT,
  SUPPORT_ERROR_TEXT,
  SUPPORT_MARKED_ANSWERED_TEXT,
} from '@/lib/panel/labels';

import { useTwoStep } from './form-feedback';
import { markPanelBusy } from './LiveRefresh';
import { PanelNote } from './PanelNote';

/**
 * Кнопка «Отвечено» — ручная отметка обращения.
 *
 * Клиенту ответили мимо панели (личным сообщением в Telegram), строки
 * оператора в переписке от этого нет, и обращение иначе висело бы «без ответа»
 * бессрочно. Клиенту кнопка не шлёт НИЧЕГО.
 *
 * Рисуется ТОЛЬКО там, где есть что снимать: решение принимает страница по
 * флагу `awaitingOperator` — тому же правилу, которым операция проверяет
 * обращение. Кнопка, которая отвечает отказом, хуже её отсутствия.
 */
export function SupportMarkAnswered({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const confirm = useTwoStep();

  async function mark() {
    if (busy) return;
    // Первое нажатие только взводит кнопку. Отметка необратима, а стоит кнопка
    // В СТРОКЕ списка: промах строкой снял бы чужое обращение и со счётчика, и
    // у напоминаний — о том клиенте не вспомнил бы уже никто.
    if (!confirm.press()) return;
    setBusy(true);
    setError(null);
    const releaseBusy = markPanelBusy();
    try {
      const res = await fetch('/api/panel/support/mark-answered', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // Код отказа из ответа роута — сужением, без утверждения типа.
        const code =
          typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
            ? data.error
            : undefined;
        setError(lookupLabel(SUPPORT_ERROR_TEXT, code) ?? FALLBACK_ERROR_TEXT);
        // Отказ «уже снято» значит, что экран устарел: перерисовать его нужно
        // и здесь, иначе кнопка останется висеть у снятого обращения.
        if (code === 'not_awaiting') router.refresh();
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      // Сеть отвалилась. Молчать нельзя: сотрудник решит, что отметил.
      setError(FALLBACK_ERROR_TEXT);
    } finally {
      setBusy(false);
      releaseBusy();
    }
  }

  if (done && !error) {
    // До перерисовки строки сервером — тихая строка вместо кнопки: повторное
    // нажатие всё равно получило бы отказ.
    return <PanelNote kind="ok">{SUPPORT_MARKED_ANSWERED_TEXT}</PanelNote>;
  }

  return (
    <>
      <button type="button" className="panel-button" onClick={mark} disabled={busy}>
        {busy
          ? ACTION_TITLES.markingAnswered
          : confirm.armed
            ? ACTION_TITLES.markAnsweredConfirm
            : ACTION_TITLES.markAnswered}
      </button>
      {error ? <PanelNote kind="error">{error}</PanelNote> : null}
    </>
  );
}
