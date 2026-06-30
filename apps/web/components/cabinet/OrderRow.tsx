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
        'flex w-full items-center justify-between gap-3 text-left bg-[var(--surface)] p-3',
        'rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] shadow-[2px_2px_0_var(--shadow-ink)]',
        'transition-transform duration-150 [transition-timing-function:var(--ease-pop)]',
        'motion-safe:hover:-translate-y-0.5',
      ].join(' ')}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-[15px] font-bold text-[var(--text)]">
          {order.service}
        </span>
        <span className="block font-body text-xs text-[var(--text-muted)]">
          {order.shortId} · {formatExpires(order.createdAt)}
        </span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-1">
        {order.amountKopecks !== null && (
          <span className="font-display text-[15px] font-bold text-[var(--accent)]">
            {formatRub(order.amountKopecks)}
          </span>
        )}
        <StatusBadge status={order.status} label={order.statusLabel} />
      </span>
    </button>
  );
}
