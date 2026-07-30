'use client';

import type { ReactNode } from 'react';

import { track } from '@/lib/analytics/client';

/**
 * Раскрывающийся блок, который сам сообщает о раскрытии в аналитику.
 *
 * Отдельный клиентский компонент, а не `<details onToggle>` прямо в
 * `OrderPanel`: панель заказа — серверный компонент и рендерится в том числе на
 * пререндеренной `/styleguide`, где DOM-обработчик невозможен (Next падает на
 * build — `tsc --noEmit` такого не видит, ловит только шаг Build в CI).
 *
 * Принимает СТРОКУ `analyticsSurface`, а не колбэк: функция-проп из серверного
 * компонента в клиентский не сериализуется. Это единственная причина, по
 * которой дизайн-система знает про телеметрию — ограничение RSC, не выбор.
 * Без пропа блок остаётся обычным `<details>` и ничего не пишет.
 */
export function BreakdownDetails({
  summary,
  className = '',
  summaryClassName = '',
  analyticsSurface,
  children,
}: {
  summary: ReactNode;
  className?: string;
  summaryClassName?: string;
  analyticsSurface?: string;
  children: ReactNode;
}) {
  return (
    <details
      className={className}
      onToggle={(e) => {
        if (!analyticsSurface) return;
        if ((e.currentTarget as HTMLDetailsElement).open) {
          track('price_breakdown_open', { surface: analyticsSurface });
        }
      }}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
