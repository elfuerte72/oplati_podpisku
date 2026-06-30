'use client';

import { useState } from 'react';

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
 * запросом из PaySpace, в БД не хранятся). Тап по значению копирует его.
 */
export function CardHero({
  card,
  details,
  revealing,
  onReveal,
  onHide,
}: {
  card: CardView | null;
  details?: CardDetails | null;
  revealing?: boolean;
  onReveal?: () => void;
  onHide?: () => void;
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

  return (
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
            {copied ? '✓ Скопировано' : 'Скрыть'}
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
  );
}
