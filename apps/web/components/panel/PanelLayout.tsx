'use client';

import { useState } from 'react';

import { ACTION_TITLES } from '@/lib/panel/labels';
import { sidebarCookieString } from '@/lib/panel/sidebar';

/**
 * Раскладка панели: боковое меню слева, экран справа (панель v3).
 *
 * Клиентский здесь только КАРКАС — состояние двух кнопок и классы. Само меню,
 * счётчики работы и «кто вошёл» приходят готовой разметкой с сервера через
 * пропсы: иначе счётчики (асинхронные серверные компоненты в `<Suspense>`)
 * пришлось бы тянуть в браузер, а роль сотрудника — отдавать клиенту.
 *
 * Два разных состояния, намеренно не сведённых в одно:
 *   - `collapsed` — свёрнутое до иконок меню на широком экране. Живёт в cookie
 *     и переживает переходы (см. `lib/panel/sidebar.ts`);
 *   - `drawerOpen` — выдвинутое меню на телефоне. Живёт только в памяти и
 *     закрывается само при переходе, потому что оболочка монтируется заново.
 *     Запоминать его было бы вредно: открытое меню закрывает собой экран.
 */
export function PanelLayout({
  collapsedInitial,
  brand,
  nav,
  actor,
  children,
}: {
  collapsedInitial: boolean;
  /** Ссылка-логотип. */
  brand: React.ReactNode;
  /** Группы пунктов меню — серверная разметка. */
  nav: React.ReactNode;
  /** «Кто вошёл» и выход — серверная разметка. */
  actor: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(collapsedInitial);
  const [drawerOpen, setDrawerOpen] = useState(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // Пишем cookie сразу: следующий переход рендерится сервером уже в нужном
    // виде. Перерисовку не запрашиваем — разметка меню от состояния не зависит,
    // меняются только классы.
    document.cookie = sidebarCookieString(next);
  }

  return (
    <div className="panel-shell" data-collapsed={collapsed ? '' : undefined} data-drawer={drawerOpen ? '' : undefined}>
      <aside className="panel-sidebar" id="panel-menu">
        <div className="panel-sidebar__head">
          {brand}
          <button
            type="button"
            className="panel-icon-button panel-sidebar__collapse"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="panel-menu"
            title={collapsed ? ACTION_TITLES.expandMenu : ACTION_TITLES.collapseMenu}
          >
            <span className="panel-visually-hidden">
              {collapsed ? ACTION_TITLES.expandMenu : ACTION_TITLES.collapseMenu}
            </span>
            <span aria-hidden>{collapsed ? '»' : '«'}</span>
          </button>
        </div>

        <nav className="panel-sidebar__nav" onClick={() => setDrawerOpen(false)}>
          {nav}
        </nav>

        <div className="panel-sidebar__foot">{actor}</div>
      </aside>

      {/*
       * Затемнение под выдвинутым меню. Кнопка, а не `div` с обработчиком:
       * закрыть меню касанием мимо него должно быть можно и с клавиатуры.
       */}
      <button
        type="button"
        className="panel-scrim"
        hidden={!drawerOpen}
        onClick={() => setDrawerOpen(false)}
        aria-label={ACTION_TITLES.closeMenu}
      />

      <div className="panel-body">
        <div className="panel-topbar">
          <button
            type="button"
            className="panel-icon-button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="panel-menu"
          >
            <span className="panel-visually-hidden">{ACTION_TITLES.openMenu}</span>
            <span aria-hidden>☰</span>
          </button>
          {brand}
        </div>

        <main className="panel-main">
          <div className="panel-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
