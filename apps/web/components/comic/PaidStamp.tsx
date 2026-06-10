type PaidStampProps = {
  label?: string;
};

/** Штамп «ОПЛАЧЕНО» — «впечатывается» поверх панели заказа после оплаты. */
export function PaidStamp({ label = 'Оплачено' }: PaidStampProps) {
  return (
    <span
      className={[
        'inline-block -rotate-12 select-none',
        'font-display font-bold uppercase tracking-wider text-[var(--color-stamp)]',
        'rounded-[10px] border-4 border-[var(--color-stamp)] px-4 py-1',
        'motion-safe:animate-[stamp-slam_420ms_var(--ease-pop)_both]',
      ].join(' ')}
    >
      {label}
    </span>
  );
}
