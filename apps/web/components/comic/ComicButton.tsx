import type { ComponentPropsWithoutRef } from 'react';

type ComicButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'surface';
};

const VARIANTS: Record<NonNullable<ComicButtonProps['variant']>, string> = {
  primary: 'bg-[var(--color-teal-primary)] text-[var(--color-paper)]',
  surface: 'bg-[var(--surface)] text-[var(--text)]',
};

/**
 * Комикс-кнопка: контур + жёсткая тень; нажатие «вдавливает»
 * (сдвиг на величину тени + снятие тени) — фирменный тактильный отклик.
 */
export function ComicButton({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ComicButtonProps) {
  return (
    <button
      type={type}
      className={[
        'font-display font-bold',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)]',
        'shadow-[var(--shadow-comic)] px-5 py-3',
        'transition-[transform,box-shadow]',
        'active:translate-x-[3px] active:translate-y-[3px] active:shadow-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        className,
      ].join(' ')}
      {...props}
    />
  );
}
