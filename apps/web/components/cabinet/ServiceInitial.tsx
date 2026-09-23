/**
 * Кружок с первой буквой сервиса — для строк заказов, где слага сервиса нет
 * (сводка заказа несёт только название), а значит, и логотипа. Вид — по
 * макету вкладок (`mockup/Main.dc.html`, «Ждут оплаты»).
 */
export function ServiceInitial({ name }: { name: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || '·';
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] font-display text-lg font-bold text-[var(--color-ink)]"
    >
      {letter}
    </span>
  );
}
