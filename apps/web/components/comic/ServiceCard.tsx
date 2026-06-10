import type { ReactNode } from 'react';
import { formatRub } from './format';

type ServiceCardProps = {
  name: string;
  plan: string;
  period: string;
  priceKopecks: number;
  logo?: ReactNode;
  action?: ReactNode;
};

/** Карточка сервиса для колоды каталога (search_catalog). */
export function ServiceCard({
  name,
  plan,
  period,
  priceKopecks,
  logo,
  action,
}: ServiceCardProps) {
  return (
    <div
      className={[
        'w-[260px] overflow-hidden bg-[var(--surface)]',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
        'transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[var(--shadow-comic-lg)]',
        'motion-safe:animate-[comic-pop_220ms_var(--ease-pop)_both]',
      ].join(' ')}
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <span className="grid h-10 w-10 place-items-center rounded-xl border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] font-display text-lg font-bold text-[var(--text)]">
          {logo ?? name.slice(0, 1)}
        </span>
        <span className="font-display text-lg font-bold text-[var(--text)]">
          {name}
        </span>
      </div>
      <p className="px-4 pt-1 font-body text-sm text-[var(--text-muted)]">
        {plan} · {period}
      </p>
      <div className="mt-3 border-t-2 border-[var(--shadow-ink)]" />
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-display text-xl font-bold text-[var(--accent)]">
          {formatRub(priceKopecks)}
        </span>
        {action}
      </div>
    </div>
  );
}
