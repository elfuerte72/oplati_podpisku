import Link from 'next/link';

/**
 * Постоянный футер со ссылками на публичные документы. По требованию платёжного
 * провайдера они должны быть доступны с любого экрана — поэтому рендерится на
 * уровне shell'а (всегда видим), а не внутри StartScreen (который скрывается
 * при выборе сервиса).
 */
export function DocsFooter({ className = '' }: { className?: string }) {
  return (
    <nav
      aria-label="Документы и контакты"
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-body text-xs text-[var(--text-muted)] ${className}`}
    >
      <Link href="/about" className="underline transition-colors hover:text-[var(--text)]">
        О сервисе
      </Link>
      <span aria-hidden>·</span>
      <Link href="/terms" className="underline transition-colors hover:text-[var(--text)]">
        Пользовательское соглашение
      </Link>
      <span aria-hidden>·</span>
      <Link href="/privacy" className="underline transition-colors hover:text-[var(--text)]">
        Политика конфиденциальности
      </Link>
    </nav>
  );
}
