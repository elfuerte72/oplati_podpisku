'use client';

import { useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import {
  PAYMENT_ISSUE_CHECKLIST,
  PAYMENT_ISSUE_LABELS,
  PAYMENT_ISSUE_TYPES,
  type PaymentIssueType,
} from '@/lib/cabinet/payment-issues';

import type { PaymentIssueResult } from './cabinet-api';

/**
 * «Не проходит оплата?» после выдачи карты: чек-лист «сначала проверь», тип
 * проблемы и комментарий — одним нажатием оператору уходит весь контекст
 * заказа (`doReportPaymentIssue`).
 *
 * Отдельным компонентом (трек miniapp-tabs, тикет 06): форму открывают и экран
 * выполненного заказа, и лист «Не получается оплатить?» на вкладке «Карта».
 * Логика прежняя — вынесена из `AfterCardBlock` без изменений.
 */
export function PaymentIssueForm({
  onReport,
  onSent,
  onError,
}: {
  onReport: (issueType: PaymentIssueType, comment?: string) => Promise<PaymentIssueResult>;
  /** Обращение принято; `duplicate` — оно уже было у оператора. */
  onSent: (duplicate: boolean) => void;
  onError: (message: string) => void;
}) {
  const [issueType, setIssueType] = useState<PaymentIssueType>('card_declined');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (sending) return;
    setSending(true);
    const res = await onReport(issueType, comment.trim() || undefined);
    setSending(false);
    if (res.ok) onSent(res.duplicate);
    else onError(res.message);
  };

  return (
    <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] p-3.5">
      <p className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
        Сначала проверь
      </p>
      <ul className="mt-1.5 space-y-1">
        {PAYMENT_ISSUE_CHECKLIST.map((item) => (
          <li key={item} className="flex gap-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
            <span aria-hidden className="text-[var(--accent)]">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <fieldset className="mt-3">
        <legend className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
          Не помогло? Что случилось:
        </legend>
        <div className="mt-1.5 space-y-1">
          {PAYMENT_ISSUE_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2 font-body text-sm text-[var(--text)]">
              <input
                type="radio"
                name="issue-type"
                checked={issueType === type}
                onChange={() => setIssueType(type)}
                className="accent-[var(--accent)]"
              />
              {PAYMENT_ISSUE_LABELS[type]}
            </label>
          ))}
        </div>
      </fieldset>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Комментарий (необязательно)"
        aria-label="Комментарий к проблеме"
        className="mt-2.5 w-full resize-none rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-body text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
      />

      <ComicButton
        variant="primary"
        className="mt-2 w-full px-4 py-2.5 text-sm"
        disabled={sending}
        onClick={() => void send()}
      >
        {sending ? 'Отправляю…' : 'Отправить в поддержку'}
      </ComicButton>
      <p className="mt-1.5 font-body text-[11px] leading-snug text-[var(--text-muted)]">
        Оператору автоматически уйдут номер заказа, сервис, тариф, сумма и статус карты.
      </p>
    </div>
  );
}

/** Текст подтверждения — одинаковый для обоих входов в форму. */
export function paymentIssueSentText(duplicate: boolean): string {
  return duplicate
    ? 'Обращение уже у оператора — он свяжется с тобой в Telegram.'
    : 'Передал оператору всё по заказу. Он напишет тебе в Telegram.';
}
