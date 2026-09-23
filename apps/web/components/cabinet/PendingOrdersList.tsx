'use client';

import { formatExpires, formatRub } from '@/components/comic/format';
import { IconArrowRight } from '@/components/comic/icons';

import type { OrderSummary } from './cabinet-api';
import { ServiceInitial } from './ServiceInitial';

/**
 * «Ждут оплаты» на вкладке «Оплата» кабинета (решение владельца 2026-09-07).
 *
 * До этого списка заказов в кабинете не было вовсе: путь к заказу вёл только
 * через свежесозданный из каталога, и клиент, закрывший Mini App на полпути,
 * попасть обратно в свой неоплаченный заказ не мог — ни оплатить, ни отменить.
 * Полной истории покупок здесь по-прежнему нет: показываем ровно то, что ждёт
 * действия клиента.
 *
 * Пустой список не рисуем совсем — заглушка «заказов нет» только занимает место
 * над каталогом.
 */
export function PendingOrdersList({
  orders,
  onOpen,
}: {
  orders: readonly OrderSummary[];
  onOpen: (orderId: string) => void;
}) {
  if (orders.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
        Ждут оплаты{orders.length > 1 ? ` (${orders.length})` : ''}
      </h2>
      {orders.map((order) => (
        <button
          key={order.orderId}
          type="button"
          onClick={() => onOpen(order.orderId)}
          className="flex w-full items-center gap-3 rounded-2xl border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-3.5 py-3 text-left shadow-[3px_3px_0_var(--shadow-ink)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
        >
          <ServiceInitial name={order.service} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-body text-[15px] font-semibold text-[var(--text)]">
              {order.service}
            </span>
            <span className="mt-0.5 block font-body text-[13px] text-[var(--text-muted)]">
              {order.amountKopecks !== null && (
                <span className="text-[var(--text)]">
                  {/* Сумма К ОПЛАТЕ: полная цена заказа минус списанные баллы.
                      `amountKopecks` остаётся полной ценой (по ней сверяется
                      чек), поэтому здесь только вычитаем, никогда не наоборот. */}
                  {formatRub(order.amountKopecks - (order.bonus?.discountKopecks ?? 0))}
                </span>
              )}
              {order.bonus && ` · −${formatRub(order.bonus.discountKopecks)} баллами`}
              {order.amountKopecks !== null && ' · '}
              {/* Срок — то, из-за чего этот блок вообще нужен: заказ живёт часы,
                  и «до 14:30» отвечает на «успею ли» без захода внутрь. */}
              {order.expiresAt ? `до ${formatExpires(order.expiresAt)}` : order.statusLabel}
            </span>
          </span>
          <IconArrowRight size={18} className="shrink-0 text-[var(--text-muted)]" />
        </button>
      ))}
    </section>
  );
}
