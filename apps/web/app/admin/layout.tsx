import type { Metadata } from 'next';

import { PANEL_TITLE_SUFFIX } from '@/lib/panel/labels';

import './panel.css';

/**
 * Оболочка админ-панели.
 *
 * Здесь только скоуп оформления (`.panel`) и запрет индексации. Меню и «кто
 * вошёл» живут глубже — на страницах, которые уже знают актора: layout в
 * Next рендерится и для страницы входа, где актора ещё нет.
 */

/**
 * Заголовок вкладки собирается шаблоном: страница называет только свой раздел
 * («Заказы»), суффикс один на панель. Четыре открытые вкладки обязаны
 * различаться — с одним заголовком на весь раздел они были неотличимы.
 */
export const metadata: Metadata = {
  title: { default: PANEL_TITLE_SUFFIX, template: `%s — ${PANEL_TITLE_SUFFIX}` },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="panel">{children}</div>;
}
