/**
 * Гейт фиксации цены (H-2 аудита 2026-07-18).
 *
 * Курс USDT/RUB снапшотится при `propose_order`, UI обещает «Цена зафиксирована
 * до <expiresAt>» — сервер обязан это форсить. Черновик `ready_for_payment` с
 * истёкшим `expires_at` нельзя доводить до счёта: клиент оплатил бы по
 * устаревшему курсу (односторонний опцион против маржи). Протухшие черновики
 * хоронит cron `expire-payments` (findExpiredPayableOrders); этот хелпер
 * закрывает 15-минутное окно между прогонами cron в `/api/payments/create`.
 *
 * `pending_payment` сюда осознанно не входит: счёт уже выставлен, его судьбу
 * решают TTL инвойса L&P и cron.
 */
export function isPriceLockExpired(
  order: { status: string; expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    order.status === 'ready_for_payment' &&
    order.expiresAt !== null &&
    // Строгое `<` — симметрия с SQL-условием `expires_at < now()` в cron-выборке.
    order.expiresAt.getTime() < now.getTime()
  );
}
