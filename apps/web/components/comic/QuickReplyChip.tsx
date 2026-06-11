import type { ComponentPropsWithoutRef } from 'react';

type QuickReplyChipProps = ComponentPropsWithoutRef<'button'>;

/** Контекстная подсказка-чип над полем ввода (убирает страх чистого листа). */
export function QuickReplyChip({
  className = '',
  type = 'button',
  ...props
}: QuickReplyChipProps) {
  return (
    <button
      type={type}
      className={[
        'whitespace-nowrap font-body text-sm',
        'rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] text-[var(--text)]',
        'shadow-[2px_2px_0_var(--shadow-ink)] px-3 py-1.5',
        'transition-[transform,box-shadow]',
        'active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        'hover:bg-[var(--surface-2)]',
        className,
      ].join(' ')}
      {...props}
    />
  );
}
