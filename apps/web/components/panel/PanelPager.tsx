import Link from 'next/link';
import type { ComponentProps } from 'react';

import { ACTION_TITLES, PAGER_TEXT } from '@/lib/panel/labels';

/**
 * Адрес страницы в том виде, в каком его принимает `Link`: экран заказов
 * собирает его объектом (`ordersHref`), остальные — строкой. Сужать до строки
 * значило бы заставить экран заказов собирать адрес вторым способом.
 */
type PagerHref = ComponentProps<typeof Link>['href'];

/**
 * Листание списка — одна разметка на всю панель.
 *
 * Раньше видов было три: страницы у заказов, отдельная строка со ссылками у
 * обратной связи и «показаны не все» без единой ссылки на шести экранах. Здесь
 * один вид, и подписи приходят из словаря, а не пишутся на каждом экране.
 *
 * ⚠️ Ничего не рисуем, когда листать некуда: строка «Страница 1» под коротким
 * списком — это шум, который надо взглядом пропускать каждый раз.
 */
export function PanelPager({
  page,
  hasMore,
  hrefFor,
}: {
  page: number;
  hasMore: boolean;
  /** Адрес страницы N — экран знает свои параметры, компонент их не трогает. */
  hrefFor: (page: number) => PagerHref;
}) {
  if (page === 1 && !hasMore) return null;

  return (
    <nav className="panel-pager" aria-label={PAGER_TEXT.label}>
      <span className="panel-muted">
        {PAGER_TEXT.page} {page}
      </span>
      {page > 1 ? <Link href={hrefFor(page - 1)}>{ACTION_TITLES.prevPage}</Link> : null}
      {hasMore ? <Link href={hrefFor(page + 1)}>{ACTION_TITLES.nextPage}</Link> : null}
    </nav>
  );
}
