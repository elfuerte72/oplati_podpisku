import type { Metadata } from 'next';

import './panel.css';

/**
 * Оболочка админ-панели.
 *
 * Здесь только скоуп оформления (`.panel`) и запрет индексации. Меню и «кто
 * вошёл» живут глубже — на страницах, которые уже знают актора: layout в
 * Next рендерится и для страницы входа, где актора ещё нет.
 */

export const metadata: Metadata = {
  title: 'Панель — Оплатишка',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="panel">{children}</div>;
}
