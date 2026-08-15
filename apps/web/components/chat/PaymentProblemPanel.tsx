'use client';

import { useState } from 'react';

import { ComicButton } from '@/components/comic';
import {
  PAYMENT_PROBLEM_LABELS,
  PAYMENT_PROBLEM_TYPES,
  type PaymentProblemType,
} from '@/lib/cabinet/payment-issues';
import { fetchWithTimeout } from '@/lib/http';

/**
 * «Проблема с оплатой» под платёжной карточкой сайта (антифрод-трек,
 * тикет 10): та же логика, что в Mini App, — общий бэкенд
 * `POST /api/orders/problem` (гейт по статусу, дедуп 1 час, «я оплатил» →
 * заказ «на проверке банка», DM оператору).
 */

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; tone: 'ok' | 'err'; text: string };

export function PaymentProblemPanel({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [problemType, setProblemType] = useState<PaymentProblemType>('not_confirmed');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  const send = async () => {
    if (state.kind === 'sending') return;
    setState({ kind: 'sending' });
    try {
      const res = await fetchWithTimeout(
        '/api/orders/problem',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId, problemType }),
        },
        15_000,
      );
      const data = (await res.json()) as {
        ok?: boolean;
        duplicate?: boolean;
        text?: string;
        message?: string;
      };
      if (data.ok) {
        setOpen(false);
        setState({
          kind: 'done',
          tone: 'ok',
          text: data.duplicate
            ? 'Обращение уже у оператора — он на связи в Telegram.'
            : (data.text ?? 'Передали оператору.'),
        });
      } else {
        setState({
          kind: 'done',
          tone: 'err',
          text: data.message ?? 'Не получилось отправить. Попробуй ещё раз.',
        });
      }
    } catch {
      setState({ kind: 'done', tone: 'err', text: 'Нет связи. Попробуй ещё раз.' });
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-display text-sm font-bold text-[var(--color-stamp)] underline-offset-2 hover:underline"
      >
        Проблема с оплатой?
      </button>

      {open && (
        <div className="mt-2 max-w-md rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] p-3.5">
          <div className="space-y-1">
            {PAYMENT_PROBLEM_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 font-body text-sm text-[var(--text)]">
                <input
                  type="radio"
                  name={`payment-problem-${orderId}`}
                  checked={problemType === type}
                  onChange={() => setProblemType(type)}
                  className="accent-[var(--accent)]"
                />
                {PAYMENT_PROBLEM_LABELS[type]}
              </label>
            ))}
          </div>
          <ComicButton
            variant="primary"
            className="mt-2.5 w-full px-4 py-2 text-sm"
            disabled={state.kind === 'sending'}
            onClick={() => void send()}
          >
            {state.kind === 'sending' ? 'Отправляю…' : 'Отправить оператору'}
          </ComicButton>
          <p className="mt-1.5 font-body text-[11px] leading-snug text-[var(--text-muted)]">
            Возврат возможен, пока карта по заказу не выпущена. Чек ускорит разбор —
            его можно прислать в бота командой /support.
          </p>
        </div>
      )}

      {state.kind === 'done' && (
        <p
          role="status"
          className={[
            'mt-2 max-w-md rounded-[12px] border-2 px-3 py-2 font-body text-sm',
            state.tone === 'ok'
              ? 'border-[var(--color-teal-deep)] text-[var(--text)]'
              : 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
          ].join(' ')}
        >
          {state.text}
        </p>
      )}
    </div>
  );
}
