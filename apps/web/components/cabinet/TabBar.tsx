'use client';

import type { ReactElement } from 'react';

import type { CabinetTab } from '@/lib/cabinet/tab-swipe';

/**
 * Нижняя панель вкладок Mini App (трек miniapp-tabs, тикет 01): «Оплата»,
 * «Карта», «Профиль». Вид — по макету (`mockup/Main.dc.html`, блок
 * `<nav aria-label="Разделы">`): иконка в пилюле, подпись под ней, активная
 * вкладка — teal-пилюля и `aria-current="page"`.
 *
 * Панель лежит поверх ряда вкладок (а не под ним в потоке): так она не
 * отнимает высоту у вкладок и не дёргает их, когда прячется под клавиатуру.
 */

function IconBag() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8h12l-1 12H7L6 8z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </svg>
  );
}

function IconCard() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

function IconPerson() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.6-4 4.6-6 8-6s6.4 2 8 6" />
    </svg>
  );
}

const ITEMS: readonly { id: CabinetTab; label: string; Icon: () => ReactElement }[] = [
  { id: 'pay', label: 'Оплата', Icon: IconBag },
  { id: 'card', label: 'Карта', Icon: IconCard },
  { id: 'profile', label: 'Профиль', Icon: IconPerson },
];

/** Высота панели без safe-area — под неё вкладки держат нижний отступ. */
export const TAB_BAR_HEIGHT_PX = 72;

export function TabBar({
  tab,
  onSelect,
  hidden,
  highlight,
  inert,
}: {
  tab: CabinetTab;
  onSelect: (tab: CabinetTab) => void;
  /** Клавиатура открыта: панель села бы ей на крышку и закрыла поле ввода. */
  hidden: boolean;
  /** Разовая подсветка вкладки после онбординга (тикет 11). */
  highlight: CabinetTab | null;
  /** Открыт лист или онбординг — панель под ними не нажимается. */
  inert: boolean;
}) {
  if (hidden) return null;
  return (
    <nav
      aria-label="Разделы"
      inert={inert}
      className="absolute inset-x-0 bottom-0 z-30 border-t-2 border-[var(--shadow-ink)] bg-[color-mix(in_srgb,var(--surface)_55%,var(--bg))] px-3 pt-2 pb-[max(14px,env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-md gap-1.5">
        {ITEMS.map(({ id, label, Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-current={active ? 'page' : undefined}
              className={[
                'relative flex min-h-[48px] flex-1 flex-col items-center gap-[3px] font-body text-xs',
                active ? 'font-semibold text-[var(--accent)]' : 'font-medium text-[var(--text-muted)]',
              ].join(' ')}
            >
              <span
                className={[
                  'flex h-[30px] w-[58px] items-center justify-center rounded-full transition-colors duration-200',
                  active ? 'bg-[color-mix(in_srgb,var(--color-teal-primary)_24%,transparent)]' : '',
                ].join(' ')}
              >
                <Icon />
              </span>
              <span>{label}</span>
              {highlight === id && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-0.5 rounded-[16px] border-[3px] border-[var(--color-teal-light)] motion-safe:animate-[spotlight-pulse_1.1s_ease-in-out_infinite]"
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
