import type { ReactNode } from 'react';

/**
 * Шапка экрана панели: заголовок, пояснение, действия справа.
 *
 * Один компонент вместо карточки с `h1` + `p.panel-muted`, собираемой вручную
 * на каждой странице: одинаковые экраны обязаны выглядеть одинаково, и
 * отступ/иерархия не должны зависеть от того, кто верстал страницу последним.
 */
export function PanelPageHeader({
  title,
  children,
  aside,
}: {
  title: ReactNode;
  /** Пояснение под заголовком и всё, что относится к шапке (фильтры, поиск). */
  children?: ReactNode;
  /** Действия справа от заголовка. */
  aside?: ReactNode;
}) {
  return (
    // Не карточка: шапка, справка, таблица и пагинация давали четыре рамки и
    // четыре радиуса там, где хватает разделителя и отступа (HIG Layout).
    <section className="panel-page-header">
      <div className="panel-page-header__main">
        <h1 className="panel-title">{title}</h1>
        {children}
      </div>
      {aside ? <div className="panel-page-header__aside">{aside}</div> : null}
    </section>
  );
}
