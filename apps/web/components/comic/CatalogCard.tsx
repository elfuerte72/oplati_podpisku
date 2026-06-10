type CatalogCardProps = {
  name: string;
  requiresKyc: boolean;
  onSelect?: () => void;
};

/**
 * Карточка сервиса из каталога (search_catalog). Цены НЕТ (её нет в каталоге —
 * контракт @oplati/agent), только название + явный CTA «Выбрать». Клик
 * отправляет «Хочу <название>» в чат. Без обрезки — название читается целиком.
 */
export function CatalogCard({ name, requiresKyc, onSelect }: CatalogCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'flex max-w-[260px] items-center gap-3 px-4 py-3 text-left',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)]',
        'shadow-[var(--shadow-comic)] transition-[transform,box-shadow]',
        'hover:-translate-y-0.5 hover:shadow-[var(--shadow-comic-lg)]',
        'active:translate-x-[3px] active:translate-y-[3px] active:shadow-none',
        'motion-safe:animate-[comic-pop_220ms_var(--ease-pop)_both]',
      ].join(' ')}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] font-display text-lg font-bold text-[var(--text)]">
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0">
        <span className="block font-display font-bold leading-tight text-[var(--text)]">
          {name}
        </span>
        <span className="block font-body text-xs font-semibold text-[var(--accent)]">
          Выбрать →{requiresKyc ? ' · нужен KYC' : ''}
        </span>
      </span>
    </button>
  );
}
