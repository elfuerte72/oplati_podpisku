import Link from 'next/link';
import type { ReactNode } from 'react';

function NavItem({
  icon,
  label,
  active = false,
  badge,
  href,
  external = false,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: string;
  /** Если задан — пункт-ссылка (реальный переход), а не mock-кнопка. */
  href?: string;
  /** Внешний ресурс: открыть в новой вкладке обычным <a> (а не next/link). */
  external?: boolean;
}) {
  const className = [
    'flex w-full items-center gap-3 rounded-[var(--radius-card)] px-3 py-2.5 text-left font-display font-bold',
    'border-[2.5px] border-[var(--shadow-ink)] transition-[transform,box-shadow]',
    active
      ? 'bg-[var(--color-teal-primary)] text-[var(--color-paper)] shadow-[var(--shadow-comic)]'
      : href
        ? 'bg-[var(--surface-2)] text-[var(--text)] shadow-[var(--shadow-comic)] motion-safe:hover:scale-[1.03]'
        : 'cursor-not-allowed bg-[var(--surface-2)] text-[var(--text-muted)] opacity-80',
  ].join(' ');

  const inner = (
    <>
      <span className="grid h-7 w-7 shrink-0 place-items-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-2 py-0.5 font-body text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
          {badge}
        </span>
      )}
    </>
  );

  if (href && external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" disabled={!active} aria-current={active ? 'page' : undefined} className={className}>
      {inner}
    </button>
  );
}

/** Левый навбар: «Оплатишка» (чат, активно) + «Обучение» (курсы — скоро, mock). */
export function LeftNav() {
  return (
    <nav className="hidden w-60 shrink-0 flex-col gap-2 border-r-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-3 md:flex">
      <div className="mb-2 px-2 py-2">
        <span className="font-display text-xl font-bold text-[var(--text)]">Оплати подписки</span>
      </div>

      <NavItem
        active
        label="Оплатишка"
        icon={
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
            <path
              d="M21 11.5a8 8 0 0 1-8.5 8 8.6 8.6 0 0 1-3.5-.7L4 20l1.3-4.2A8 8 0 1 1 21 11.5z"
              strokeLinejoin="round"
            />
          </svg>
        }
      />
      <NavItem
        label="VPN"
        badge="Бета"
        href="https://goateed-misguidingly-michelle.ngrok-free.dev/"
        external
        icon={
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
            <path d="M12 3l7 3v5c0 4.4-3 8.2-7 9-4-0.8-7-4.6-7-9V6l7-3z" strokeLinejoin="round" />
            <path d="M9.5 12l1.8 1.8L15 10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      />
      {/* «Партнёрская программа» оставлена ОДНОЙ кнопкой в правой панели профиля
          (ProfilePanel) — здесь дубль убран по фидбеку владельца. */}
      <NavItem
        label="Обучение"
        badge="Скоро"
        icon={
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
            <path d="M3 9l9-5 9 5-9 5-9-5z" strokeLinejoin="round" />
            <path d="M7 11v5c0 1 2.2 2.5 5 2.5s5-1.5 5-2.5v-5" strokeLinejoin="round" />
          </svg>
        }
      />

      <p className="mt-auto px-2 font-body text-xs text-[var(--text-muted)]">
        Курсы по подпискам и сервисам появятся позже.
      </p>
    </nav>
  );
}
