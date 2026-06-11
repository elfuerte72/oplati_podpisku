'use client';

const STORAGE_KEY = 'oplatishka-theme';

/**
 * Тумблер light «бумажный комикс» / dark «комикс-нуар». Тёмная — по умолчанию.
 * Без React-state: иконки переключаются CSS-ом по `html[data-theme]` (см.
 * globals.css), обработчик меняет атрибут + localStorage. Ранний inline-скрипт
 * в layout применяет сохранённый выбор до пейнта (без FOUC).
 */
export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // приватный режим / отключённый storage — не критично
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Сменить тему (светлая/тёмная)"
      title="Сменить тему"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
    >
      <svg className="theme-icon-dark h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 1 0 9.8 9.8z" strokeLinejoin="round" />
      </svg>
      <svg className="theme-icon-light h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
