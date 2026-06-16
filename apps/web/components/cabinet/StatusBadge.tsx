/**
 * Бейдж статуса заказа/платежа/карты в комикс-стиле. Цвет — по смысловой группе
 * статуса (успех / в процессе / проблема). Чистый компонент (RSC-совместим).
 */

const SUCCESS = new Set(['paid', 'in_fulfillment', 'completed', 'succeeded', 'active']);
const DANGER = new Set(['failed', 'cancelled', 'expired', 'refunded']);

type Tone = 'success' | 'danger' | 'pending';

function toneFor(status: string): Tone {
  if (SUCCESS.has(status)) return 'success';
  if (DANGER.has(status)) return 'danger';
  return 'pending';
}

const TONE_CLASSES: Record<Tone, string> = {
  success: 'border-[var(--color-teal-deep)] bg-[var(--color-teal-primary)] text-[var(--color-paper)]',
  danger: 'border-[var(--color-stamp)] text-[var(--color-stamp)] bg-transparent',
  pending: 'border-[var(--color-brown)] text-[var(--color-brown)] bg-transparent',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={[
        'inline-block whitespace-nowrap rounded-full border-2 px-3 py-0.5',
        'font-display text-xs font-bold uppercase tracking-wide',
        TONE_CLASSES[toneFor(status)],
      ].join(' ')}
    >
      {label}
    </span>
  );
}
