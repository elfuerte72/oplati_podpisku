import { StatusBadge } from './StatusBadge';
import type { CardView } from './cabinet-api';

/** USD-центы → «$12.34». */
function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Секция карт кабинета: только маскированный PAN, статус и баланс. Полные
 * реквизиты (PAN/CVC) сюда не приходят — инвариант безопасности: они уходят
 * клиенту единственным путём, сообщением в Telegram.
 */
export function CardsSection({ cards }: { cards: CardView[] }) {
  if (cards.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
        Карты
      </h2>
      {cards.map((card) => (
        <div
          key={card.panMasked + card.createdAt}
          className={[
            'flex items-center justify-between gap-4 bg-[var(--surface)] p-4',
            'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
          ].join(' ')}
        >
          <div>
            <p className="font-display text-lg font-bold tracking-wider text-[var(--text)]">
              {card.panMasked}
            </p>
            <p className="mt-0.5 font-body text-sm text-[var(--text-muted)]">
              Баланс: {formatUsd(card.balanceUsdCents)}
            </p>
          </div>
          <StatusBadge status={card.status} label={card.statusLabel} />
        </div>
      ))}
    </section>
  );
}
