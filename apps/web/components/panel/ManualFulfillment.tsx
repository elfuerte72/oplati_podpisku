'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  MANUAL_FULFILLMENT_COMMENT_MAX,
  MANUAL_FULFILLMENT_COMMENT_MIN,
  type ManualFulfillmentAction,
} from '@/lib/panel/fulfillment';
import { lookupLabel } from '@/lib/panel/format';
import {
  ACTION_TITLES,
  FALLBACK_ERROR_TEXT,
  FULFILLMENT_DONE_TEXT,
  FULFILLMENT_ERROR_TEXT,
} from '@/lib/panel/labels';

import { useFlash, useTwoStep } from './form-feedback';
import { markPanelBusy } from './LiveRefresh';
import { PanelNote } from './PanelNote';

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
  const [flash, setFlash] = useFlash();
  const confirm = useTwoStep();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // ⚠️ Подтверждения просит ТОЛЬКО отметка о выдаче: она уводит заказ в
    // терминальный «выполнен», откуда статус-машина не выпускает. «Взять в
    // работу» обратимо ручной выдачей и лишним шагом не обкладывается.
    if (action === 'complete' && !confirm.press()) return;

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
      // Раньше экран не говорил НИЧЕГО: комментарий очищался, и о том, что
      // заказ переведён, менеджер узнавал по изменившемуся статусу — если
      // замечал его.
      setFlash(
        action === 'start' ? FULFILLMENT_DONE_TEXT.started : FULFILLMENT_DONE_TEXT.completed,
      );
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

      {error ? <PanelNote kind="error">{error}</PanelNote> : null}
      {flash ? <PanelNote kind="ok">{flash}</PanelNote> : null}

      {/* Заметная кнопка карточки заказа: ручная выдача — то, ради чего сюда
          заходят, и второго такого действия на экране нет. */}
      <button
        type="submit"
        className="panel-button panel-button--primary"
        style={{ marginTop: 8 }}
        disabled={busy}
      >
        {buttonLabel({ action, busy, armed: confirm.armed })}
      </button>
    </form>
  );
}

/**
 * Подпись кнопки: действие → подтверждение → ожидание. Ожидание называется
 * СЛОВОМ, а не одной приглушённостью: по гаснущей кнопке не понять, идёт
 * запрос или клик вообще не прошёл.
 */
function buttonLabel(state: {
  action: ManualFulfillmentAction;
  busy: boolean;
  armed: boolean;
}): string {
  if (state.action === 'start') {
    return state.busy ? ACTION_TITLES.fulfillmentStarting : ACTION_TITLES.fulfillmentStart;
  }
  if (state.busy) return ACTION_TITLES.fulfillmentCompleting;
  return state.armed
    ? ACTION_TITLES.fulfillmentCompleteConfirm
    : ACTION_TITLES.fulfillmentComplete;
}
