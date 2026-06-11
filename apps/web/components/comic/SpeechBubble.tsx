import type { ReactNode } from 'react';

type SpeechBubbleProps = {
  from: 'bot' | 'user';
  children: ReactNode;
};

/**
 * Комикс-облако с хвостиком. Бот — хвост слева, пользователь — справа.
 * Горизонтальное выравнивание задаёт родительская строка (justify-start/end),
 * здесь только вид. AI-текст — plain text + автолинк (без markdown).
 */
export function SpeechBubble({ from, children }: SpeechBubbleProps) {
  const isUser = from === 'user';
  return (
    <div
      className={[
        'relative max-w-[min(85%,34rem)] font-body leading-snug',
        'border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
        'rounded-[var(--radius-bubble)] px-4 py-3',
        'motion-safe:animate-[comic-pop_180ms_var(--ease-pop)_both]',
        isUser
          ? 'rounded-br-[6px] bg-[var(--bubble-user)] text-[var(--color-paper)]'
          : 'rounded-bl-[6px] bg-[var(--bubble-bot)] text-[var(--text)]',
      ].join(' ')}
    >
      {children}
      <span
        aria-hidden
        className={[
          'absolute bottom-2 h-3 w-3 rotate-45 border-[var(--shadow-ink)]',
          isUser
            ? '-right-[8px] border-r-[2.5px] border-t-[2.5px] bg-[var(--bubble-user)]'
            : '-left-[8px] border-b-[2.5px] border-l-[2.5px] bg-[var(--bubble-bot)]',
        ].join(' ')}
      />
    </div>
  );
}
