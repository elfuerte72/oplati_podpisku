import type { ServicePaymentInstructions } from '@oplati/types';

import {
  GENERIC_INSTRUCTION_TEXT,
  VPN_WARNING_TEXT,
  instructionPoints,
} from '@/lib/catalog/instructions';

/**
 * Блок «Важно перед оплатой» — пер-сервисные правила оплаты (ТЗ §5): VPN не
 * показываем общим советом, для каждого сервиса — свои локация/валюта/billing.
 * `instructions === null` → generic-подсказка (запись в каталоге не заведена).
 */
export function ServiceInstructions({
  instructions,
  className = '',
}: {
  instructions: ServicePaymentInstructions | null | undefined;
  className?: string;
}) {
  const points = instructions ? instructionPoints(instructions) : null;

  return (
    <div
      className={[
        'rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-3',
        className,
      ].join(' ')}
    >
      <p className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
        Важно перед оплатой
      </p>
      {points ? (
        <>
          <ul className="mt-1.5 space-y-1">
            {points.map((point) => (
              <li key={point} className="flex gap-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
                <span aria-hidden className="text-[var(--accent)]">•</span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
          {instructions?.requiresVpn && (
            <p className="mt-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
              {VPN_WARNING_TEXT}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
          {GENERIC_INSTRUCTION_TEXT}
        </p>
      )}
    </div>
  );
}
