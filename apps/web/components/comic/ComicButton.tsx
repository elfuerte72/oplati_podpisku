import type { ComponentPropsWithoutRef } from 'react';

type ComicButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'surface';
};

const VARIANTS: Record<NonNullable<ComicButtonProps['variant']>, string> = {
  primary: 'bg-[var(--color-teal-primary)] text-[var(--color-paper)]',
  surface: 'bg-[var(--surface)] text-[var(--text)]',
};

/**
 * Классы комикс-кнопки отдельной функцией: тот же вид нужен и `<a>`-ссылкам
 * (привязка Telegram — прямой тап по якорю, см. TelegramLink.tsx), а «кнопка,
 * которая на самом деле ссылка» должна выглядеть неотличимо от ComicButton.
 */
export function comicButtonClassName(
  variant: NonNullable<ComicButtonProps['variant']> = 'primary',
  className = '',
): string {
  return [
    'font-display font-bold',
    'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)]',
    'shadow-[var(--shadow-comic)] px-5 py-3',
    'transition-[transform,box-shadow] duration-150 [transition-timing-function:var(--ease-pop)]',
    'motion-safe:hover:scale-[1.07] motion-safe:hover:shadow-[var(--shadow-comic-lg)]',
    'active:translate-x-[3px] active:translate-y-[3px] active:scale-100 active:shadow-none',
    'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100 disabled:hover:shadow-[var(--shadow-comic)]',
    VARIANTS[variant],
    className,
  ].join(' ');
}

/**
 * Комикс-кнопка: контур + жёсткая тень; нажатие «вдавливает»
 * (сдвиг на величину тени + снятие тени), hover «надувает» (рост + тень
 * крупнее, overshoot-изинг) — фирменный мультяшный тактильный отклик.
 */
export function ComicButton({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ComicButtonProps) {
  return <button type={type} className={comicButtonClassName(variant, className)} {...props} />;
}
