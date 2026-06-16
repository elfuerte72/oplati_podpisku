import { formatExpires, formatRub } from '@/components/comic/format';

import { StatusBadge } from './StatusBadge';
import type { OrderSummary } from './cabinet-api';

/**
 * Кликабельная карточка заказа в списке кабинета. Открывает экран деталей.
 */
export function OrderRow({
  order,
  onOpen,
}: {
  order: OrderSummary;
  onOpen: (orderId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(order.orderId)}
      className={[
        'block w-full text-left bg-[var(--surface)] p-4',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
        'transition-transform duration-150 [transition-timing-function:var(--ease-pop)]',
        'motion-safe:hover:-translate-y-0.5',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-sm font-bold text-[var(--text-muted)]">
          {order.shortId}
        </span>
        <StatusBadge status={order.status} label={order.statusLabel} />
      </div>

      <p className="mt-1 font-display text-lg font-bold text-[var(--text)]">{order.service}</p>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="font-body text-xs text-[var(--text-muted)]">
          {formatExpires(order.createdAt)}
        </span>
        {order.amountKopecks !== null && (
          <span className="font-display text-lg font-bold text-[var(--accent)]">
            {formatRub(order.amountKopecks)}
          </span>
        )}
      </div>
    </button>
  );
}
