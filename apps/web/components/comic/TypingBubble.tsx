/** «Оплатишка думает…» — облако бота с прыгающими точками во время стрима. */
export function TypingBubble() {
  return (
    <div
      className={[
        'relative inline-flex w-fit items-center gap-1.5 self-start',
        'border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
        'rounded-[var(--radius-bubble)] rounded-bl-[6px] bg-[var(--bubble-bot)] px-4 py-3.5',
      ].join(' ')}
      aria-label="Оплатишка думает"
      role="status"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-[var(--text-muted)] motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
