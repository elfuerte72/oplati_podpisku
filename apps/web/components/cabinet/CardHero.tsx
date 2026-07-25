'use client';

import { useState } from 'react';

import { formatExpires, formatUsd } from '@/components/comic/format';
import { IconCheck } from '@/components/comic/icons';
import type { CardView } from './cabinet-api';

const STATUS_DOT: Record<string, string> = {
  active: 'var(--success)',
  idle: 'var(--color-skin)',
  recycled: 'var(--text-muted)',
};

export type CardDetails = { number: string; exp: string; cvc: string };

/**
 * Карта клиента — главный акцент кабинета. По умолчанию показывает маску PAN и
 * статус; по кнопке «Показать реквизиты» — полный номер/срок/CVC (тянутся живым
 * запросом из PaySpace, в БД не хранятся; после показа автоматически скрываются
 * таймером в CabinetClient — ТЗ §4). Тап по значению копирует его.
 *
 * Под картой — контекст заказа (ТЗ §4): баланс, «Для оплаты: <сервис>»,
 * «Действует до» + кнопки «Перейти на сайт сервиса» / «Инструкция» /
 * «Не проходит оплата?».
 */
export function CardHero({
  card,
  details,
  revealing,
  onReveal,
  onHide,
  onOpenExternalLink,
  onOpenIssueOrder,
}: {
  card: CardView | null;
  details?: CardDetails | null;
  revealing?: boolean;
  onReveal?: () => void;
  onHide?: () => void;
  onOpenExternalLink?: (url: string) => void;
  /** Открыть заказ карты (там инструкция и «Не проходит оплата?» с контекстом). */
  onOpenIssueOrder?: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1400);
      })
      .catch(() => {});
  };

  if (!card) {
    return (
      <div className="flex aspect-[1.6/1] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-[2.5px] border-dashed border-[var(--shadow-ink)] bg-[var(--surface-2)] p-5 text-center">
        <span className="font-display text-base font-bold text-[var(--text)]">Карты пока нет</span>
        <span className="font-body text-sm text-[var(--text-muted)]">
          Появится после первой оплаты — реквизиты придут сюда, в Telegram.
        </span>
      </div>
    );
  }

  const paymentUrl = card.instructions?.paymentUrl ?? null;
  const actionBtn =
    'w-full rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] px-3 py-2 font-display text-[13px] font-bold shadow-[2px_2px_0_var(--shadow-ink)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none';

  return (
    <div className="space-y-2.5">
      <div
        className="halftone relative flex aspect-[1.6/1] flex-col justify-between overflow-hidden rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] p-5 text-[var(--color-paper)] shadow-[var(--shadow-comic)]"
        style={{ background: 'linear-gradient(135deg, var(--color-teal-deep), var(--color-teal-primary))' }}
      >
        {/* top: бренд + статус */}
        <div className="flex items-start justify-between">
          <span className="font-display text-lg font-bold tracking-tight">Оплатишка</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-2.5 py-0.5 font-display text-[11px] font-bold text-[var(--color-ink)]">
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_DOT[card.status] ?? 'var(--text-muted)' }} />
            {card.statusLabel}
          </span>
        </div>

        {/* chip */}
        <span className="h-7 w-10 rounded-[6px] border-2 border-[var(--shadow-ink)] bg-[var(--color-skin)]" />

        {/* номер карты (маска или полный по кнопке) */}
        {details ? (
          <button
            type="button"
            onClick={() => copy('number', details.number.replace(/\s/g, ''))}
            className="text-left font-display text-xl font-bold tracking-[0.14em]"
          >
            {details.number}
          </button>
        ) : (
          <p className="font-display text-xl font-bold tracking-[0.18em]">{card.panMasked}</p>
        )}

        {/* bottom: реквизиты по кнопке ИЛИ кнопка «Показать» */}
        {details ? (
          <div className="flex items-end justify-between gap-3">
            <button type="button" onClick={() => copy('exp', details.exp)} className="text-left">
              <span className="block font-body text-[10px] uppercase tracking-wider opacity-80">Срок</span>
              <span className="font-display text-base font-bold">{details.exp}</span>
            </button>
            <button type="button" onClick={() => copy('cvc', details.cvc)} className="text-left">
              <span className="block font-body text-[10px] uppercase tracking-wider opacity-80">CVC</span>
              <span className="font-display text-base font-bold">{details.cvc}</span>
            </button>
            <button
              type="button"
              onClick={onHide}
              className="rounded-[8px] border-2 border-[var(--color-paper)] px-2.5 py-1 font-display text-[11px] font-bold"
            >
              {copied ? (
                <span className="inline-flex items-center gap-1">
                  <IconCheck size={12} />
                  Скопировано
                </span>
              ) : (
                'Скрыть'
              )}
            </button>
          </div>
        ) : (
          <div className="flex items-end justify-between gap-2">
            <span className="font-body text-[11px] uppercase tracking-wider opacity-80">Виртуальная карта</span>
            <button
              type="button"
              onClick={onReveal}
              disabled={revealing}
              className="rounded-[8px] border-2 border-[var(--color-paper)] bg-[var(--color-paper)] px-3 py-1 font-display text-[12px] font-bold text-[var(--color-teal-deep)] disabled:opacity-70"
            >
              {revealing ? 'Загрузка…' : 'Показать реквизиты'}
            </button>
          </div>
        )}
      </div>

      {details && (
        <p className="font-body text-[11px] leading-snug text-[var(--text-muted)]">
          Тап по значению копирует его. Реквизиты скроются автоматически через минуту.
        </p>
      )}

      {/* Контекст карты: баланс, назначение, срок действия (ТЗ §4). */}
      <div className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]">
        <dl className="space-y-1">
          <div className="flex justify-between gap-4 font-body text-sm">
            <dt className="text-[var(--text-muted)]">Баланс</dt>
            <dd className="font-display font-bold text-[var(--text)]">
              {formatUsd(card.balanceUsdCents)}
            </dd>
          </div>
          {card.purpose && (
            <div className="flex justify-between gap-4 font-body text-sm">
              <dt className="text-[var(--text-muted)]">Для оплаты</dt>
              <dd className="text-right text-[var(--text)]">{card.purpose}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 font-body text-sm">
            <dt className="text-[var(--text-muted)]">Действует до</dt>
            <dd className="text-[var(--text)]">{formatExpires(card.validUntil)}</dd>
          </div>
        </dl>

        {/*
          Говорим заранее, что будет по истечении срока: карта закрывается
          автоматически (cron `recycle-cards`), и следующая оплата пойдёт по НОВОЙ
          карте, за выпуск которой PaySpace берёт фиксированную надбавку. Без этой
          строки клиент узнавал бы о надбавке только на экране заказа. Отдельных
          уведомлений перед закрытием осознанно нет (решение владельца) — поэтому
          честный текст здесь тем более обязателен.
        */}
        <p className="mt-3 font-body text-xs leading-snug text-[var(--text-muted)]">
          До этой даты все оплаты идут с этой карты без доплат. После — карта
          закроется, и для следующей оплаты мы выпустим новую: выпуск добавится к
          сумме заказа.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {paymentUrl && onOpenExternalLink && (
            <button
              type="button"
              onClick={() => onOpenExternalLink(paymentUrl)}
              className={`${actionBtn} bg-[var(--accent)] text-[var(--color-paper)]`}
            >
              Перейти на сайт сервиса
            </button>
          )}
          {onOpenExternalLink && (
            <button
              type="button"
              onClick={() => onOpenExternalLink(`${window.location.origin}/payment-instruction.html`)}
              className={`${actionBtn} bg-[var(--surface-2)] text-[var(--text)]`}
            >
              Инструкция по оплате
            </button>
          )}
          {onOpenIssueOrder && (
            <button
              type="button"
              onClick={onOpenIssueOrder}
              className="font-display text-[13px] font-bold text-[var(--color-stamp)] underline-offset-2 hover:underline"
            >
              Не проходит оплата?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
