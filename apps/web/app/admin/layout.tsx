import { cookies } from 'next/headers';
import type { Metadata } from 'next';

import { PANEL_TITLE_SUFFIX } from '@/lib/panel/labels';
import { DENSITY_COOKIE, THEME_COOKIE, readDensity, readTheme } from '@/lib/panel/prefs';

import './panel.css';

/**
 * Оболочка админ-панели.
 *
 * Здесь только скоуп оформления (`.panel`) и запрет индексации. Меню и «кто
 * вошёл» живут глубже — на страницах, которые уже знают актора: layout в
 * Next рендерится и для страницы входа, где актора ещё нет.
 *
 * Тема и плотность строк ставятся ЗДЕСЬ, потому что от них зависит и экран
 * входа, у которого оболочки с меню нет вовсе. Читаются на сервере: возьми их
 * в браузере после гидратации — и каждый переход начинался бы кадром чужой
 * темы (`lib/panel/prefs.ts`).
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

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const theme = readTheme(jar.get(THEME_COOKIE)?.value);
  const density = readDensity(jar.get(DENSITY_COOKIE)?.value);

  return (
    <div className="panel" data-theme={theme} data-density={density}>
      {children}
    </div>
  );
}
