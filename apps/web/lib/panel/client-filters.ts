import { z } from 'zod';

import {
  PANEL_CLIENT_SEGMENTS,
  PANEL_CLIENT_SORTS,
  PANEL_SEARCH_QUERY_MAX_LENGTH,
  type PanelClientSegment,
  type PanelClientSort,
} from '@oplati/db';

import { parseOptionalPeriod, type AnalyticsPeriod } from './analytics/period';
import { CLIENT_SEGMENT_TITLES, CLIENT_SORT_TITLES } from './labels';
import { firstParam, panelPageSchema } from './paging';

/**
 * Разбор адреса экрана клиентов. Параметры адреса — граница (инвариант 5),
 * поэтому Zod, а не «взять что дали». Устройство то же, что у заказов
 * (`order-filters.ts`): фильтры живут в адресе, непонятый параметр
 * откатывается к умолчанию, и экран говорит об этом вслух.
 *
 * Списки сегментов и сортировок берутся ИЗ репозитория, а не переписываются:
 * значение, которого репозиторий не знает, не должно доходить до запроса.
 * Исход клиента (`kind`) тоже приходит из репозитория — тем же предикатом,
 * что считает сегменты; второй формулы в JS здесь нет намеренно.
 */

const segmentSchema = z.enum(PANEL_CLIENT_SEGMENTS);
const sortSchema = z.enum(PANEL_CLIENT_SORTS);

export const CLIENT_SEGMENT_OPTIONS: ReadonlyArray<{ key: PanelClientSegment; title: string }> =
  PANEL_CLIENT_SEGMENTS.map((key) => ({ key, title: CLIENT_SEGMENT_TITLES[key] }));

export const CLIENT_SORT_OPTIONS: ReadonlyArray<{ key: PanelClientSort; title: string }> =
  PANEL_CLIENT_SORTS.map((key) => ({ key, title: CLIENT_SORT_TITLES[key] }));

export type PanelClientsQuery = {
  query: string;
  segment: PanelClientSegment;
  sort: PanelClientSort;
  /** Окно по дате регистрации в днях. `null` — «всё время», это умолчание. */
  period: AnalyticsPeriod | null;
  page: number;
  /** Какие параметры адреса не разобрались — экран скажет об этом вслух. */
  ignored: string[];
};

export function parseClientsQuery(
  params: Record<string, string | string[] | undefined>,
): PanelClientsQuery {
  const ignored: string[] = [];

  // Потолок поиска — тот же, что в репозитории (`@oplati/db`).
  const query = (firstParam(params.q)?.trim() ?? '').slice(0, PANEL_SEARCH_QUERY_MAX_LENGTH);

  const rawSegment = firstParam(params.seg);
  const parsedSegment = rawSegment ? segmentSchema.safeParse(rawSegment) : null;
  if (rawSegment && !parsedSegment?.success) ignored.push('seg');

  const rawSort = firstParam(params.sort);
  const parsedSort = rawSort ? sortSchema.safeParse(rawSort) : null;
  if (rawSort && !parsedSort?.success) ignored.push('sort');

  const rawPeriod = firstParam(params.period);
  const period = parseOptionalPeriod(rawPeriod);
  if (rawPeriod && period === null) ignored.push('period');

  const rawPage = firstParam(params.page);
  const parsedPage = rawPage ? panelPageSchema.safeParse(rawPage) : null;
  if (rawPage && !parsedPage?.success) ignored.push('page');

  return {
    query,
    segment: parsedSegment?.success ? parsedSegment.data : 'all',
    sort: parsedSort?.success ? parsedSort.data : 'newest',
    period,
    page: parsedPage?.success ? parsedPage.data : 1,
    ignored,
  };
}

/** Собрать адрес экрана клиентов из состояния фильтров. */
export function clientsHref(
  state: Partial<Pick<PanelClientsQuery, 'query' | 'segment' | 'sort' | 'period' | 'page'>>,
): { pathname: string; query: Record<string, string> } {
  const query: Record<string, string> = {};
  if (state.segment && state.segment !== 'all') query.seg = state.segment;
  if (state.query) query.q = state.query;
  if (state.sort && state.sort !== 'newest') query.sort = state.sort;
  if (state.period) query.period = String(state.period);
  if (state.page && state.page > 1) query.page = String(state.page);
  return { pathname: '/admin/clients', query };
}
