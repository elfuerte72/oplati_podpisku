import type { ReactNode } from 'react';
import { formatRub } from './format';

type OrderRow = { label: string; value: string };

type OrderPanelProps = {
  title?: string;
  service: string;
  rows?: OrderRow[];
  amountKopecks: number;
  confirm?: ReactNode;
  secondary?: ReactNode;
  stamp?: ReactNode;
};

/** Панель заказа (propose_order) — комикс-панель с суммой и подтверждением. */
export function OrderPanel({
  title = 'Заказ',
  service,
  rows = [],
  amountKopecks,
  confirm,
  secondary,
  stamp,
}: OrderPanelProps) {
  return (
    <div
      className={[
        'relative w-[320px] max-w-full bg-[var(--surface)] p-5',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic-lg)]',
      ].join(' ')}
    >
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h3>
      <p className="mt-1 font-display text-xl font-bold text-[var(--text)]">
        {service}
      </p>

      {rows.length > 0 && (
        <dl className="mt-3 space-y-1 font-body text-sm text-[var(--text-muted)]">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <dt>{row.label}</dt>
              <dd className="text-[var(--text)]">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="my-4 border-t-2 border-[var(--shadow-ink)]" />

      <div className="flex items-baseline justify-between">
        <span className="font-body text-sm text-[var(--text-muted)]">К оплате</span>
        <span className="font-display text-2xl font-bold text-[var(--accent)]">
          {formatRub(amountKopecks)}
        </span>
      </div>

      {(confirm || secondary) && (
        <div className="mt-4 flex items-center gap-3">
          {confirm}
          {secondary}
        </div>
      )}

      {stamp && (
        <div className="pointer-events-none absolute right-4 top-4">{stamp}</div>
      )}
    </div>
  );
}
