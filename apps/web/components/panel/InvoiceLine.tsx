import { discountedInvoiceLine } from '@/lib/panel/format';

/**
 * Приглушённая строка под полной ценой заказа в списках панели: «счёт 2 295 ₽ ·
 * −405 ₽ промокод · −300 ₽ баллами». Без скидок не рисуется ничего. Правило —
 * одно на три экрана (`discountedInvoiceLine`).
 */
export function InvoiceLine({ row }: { row: Parameters<typeof discountedInvoiceLine>[0] }) {
  const text = discountedInvoiceLine(row);
  return text ? <div className="panel-muted">{text}</div> : null;
}
