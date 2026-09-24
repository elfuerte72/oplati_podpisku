import type { PathStep } from '@/lib/cabinet/path-steps';

/**
 * Три шага пути клиента (трек miniapp-tabs, тикеты 05 и 06) — вид по макету
 * (`mockup/Order.dc.html`, `Card.dc.html`). Тексты и состояния считает чистая
 * `buildPathSteps`; здесь только отрисовка: сделано — галочка на teal, текущий
 * — номер на teal с обводкой, впереди — номер в пустом круге.
 */
export function PathSteps({
  steps,
  boxed = false,
  className = '',
}: {
  steps: readonly PathStep[];
  /** Своя подложка (лист заказа); без неё — шаги внутри чужой карточки. */
  boxed?: boolean;
  className?: string;
}) {
  return (
    <ol
      className={[
        'flex flex-col gap-2.5',
        boxed ? 'rounded-[14px] bg-[var(--surface-2)] p-3' : '',
        className,
      ].join(' ')}
    >
      {steps.map((step) => (
        <li
          key={step.n}
          className="flex items-start gap-2.5"
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <StepMark step={step} />
          <span className="min-w-0 pt-[3px]">
            <span
              className={[
                'block font-body text-[15px] leading-snug',
                step.state === 'ahead'
                  ? 'font-medium text-[var(--text-muted)]'
                  : 'font-semibold text-[var(--text)]',
              ].join(' ')}
            >
              {step.title}
              {step.state === 'done' && <span className="sr-only"> — сделано</span>}
            </span>
            {step.hint && (
              <span className="mt-px block font-body text-[13px] leading-snug text-[var(--text-muted)]">
                {step.hint}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ step }: { step: PathStep }) {
  if (step.state === 'done') {
    return (
      <span
        aria-hidden
        className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[var(--color-teal-primary)] text-[var(--color-paper)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.2 4L19 7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={[
        'box-border flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 font-body text-[13px] font-bold',
        step.state === 'current'
          ? 'border-[var(--color-teal-light)] bg-[var(--color-teal-deep)] text-[var(--color-paper)]'
          : 'border-[color-mix(in_srgb,var(--text-muted)_45%,transparent)] text-[var(--text-muted)]',
      ].join(' ')}
    >
      {step.n}
    </span>
  );
}
