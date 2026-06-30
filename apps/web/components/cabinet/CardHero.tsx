import type { CardView } from './cabinet-api';

/** USD-центы → «$12.34». */
function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

const STATUS_DOT: Record<string, string> = {
  active: 'var(--success)',
  idle: 'var(--color-skin)',
  recycled: 'var(--text-muted)',
};

/**
 * Карта клиента — главный акцент минималистичного кабинета. Визуал виртуальной
 * карты: бренд, маскированный PAN, баланс, статус. Полные реквизиты (PAN/CVC)
 * сюда НЕ приходят (инвариант безопасности — только сообщением в Telegram при
 * выпуске); здесь — `panMasked` + баланс + статус.
 */
export function CardHero({ card }: { card: CardView | null }) {
  if (!card) {
    return (
      <div className="flex aspect-[1.6/1] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-[2.5px] border-dashed border-[var(--shadow-ink)] bg-[var(--surface-2)] p-5 text-center">
        <span className="font-display text-base font-bold text-[var(--text)]">Карты пока нет</span>
        <span className="font-body text-sm text-[var(--text-muted)]">
          Появится после первой оплаты — реквизиты придут сюда, в Telegram.
        </span>
      </div>
    );
  }

  return (
    <div
      className="halftone relative flex aspect-[1.6/1] flex-col justify-between overflow-hidden rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] p-5 text-[var(--color-paper)] shadow-[var(--shadow-comic)]"
      style={{ background: 'linear-gradient(135deg, var(--color-teal-deep), var(--color-teal-primary))' }}
    >
      {/* top: бренд + статус */}
      <div className="flex items-start justify-between">
        <span className="font-display text-lg font-bold tracking-tight">Оплатишка</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-paper)] px-2.5 py-0.5 font-display text-[11px] font-bold text-[var(--color-ink)]">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: STATUS_DOT[card.status] ?? 'var(--text-muted)' }}
          />
          {card.statusLabel}
        </span>
      </div>

      {/* chip */}
      <span className="h-7 w-10 rounded-[6px] border-2 border-[var(--shadow-ink)] bg-[var(--color-skin)]" />

      {/* PAN */}
      <p className="font-display text-xl font-bold tracking-[0.18em]">{card.panMasked}</p>

      {/* bottom: баланс + тип */}
      <div className="flex items-end justify-between">
        <span>
          <span className="block font-body text-[11px] uppercase tracking-wider opacity-80">Баланс</span>
          <span className="font-display text-xl font-bold">{formatUsd(card.balanceUsdCents)}</span>
        </span>
        <span className="font-body text-[11px] uppercase tracking-wider opacity-80">Виртуальная карта</span>
      </div>
    </div>
  );
}
