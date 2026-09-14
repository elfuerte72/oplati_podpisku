import { z } from 'zod';

import {
  PANEL_CLIENT_SEGMENTS,
  PANEL_CLIENT_SORTS,
  type PanelClientSegment,
  type PanelClientSort,
} from '@oplati/db';

import { ANALYTICS_PERIODS, type AnalyticsPeriod } from './analytics/period';
import { CLIENT_SEGMENT_TITLES, CLIENT_SORT_TITLES } from './labels';

/**
 * Разбор адреса экрана клиентов. Параметры адреса — граница (инвариант 5),
 * поэтому Zod, а не «взять что дали». Устройство то же, что у заказов
 * (`order-filters.ts`): фильтры живут в адресе, непонятый параметр
 * откатывается к умолчанию, и экран говорит об этом вслух.
 *
 * Списки сегментов и сортировок берутся ИЗ репозитория, а не переписываются:
 * значение, которого репозиторий не знает, не должно доходить до запроса.
 */

const segmentSchema = z.enum(PANEL_CLIENT_SEGMENTS);
const sortSchema = z.enum(PANEL_CLIENT_SORTS);

export const CLIENT_SEGMENT_OPTIONS: ReadonlyArray<{ key: PanelClientSegment; title: string }> =
  PANEL_CLIENT_SEGMENTS.map((key) => ({ key, title: CLIENT_SEGMENT_TITLES[key] }));

export const CLIENT_SORT_OPTIONS: ReadonlyArray<{ key: PanelClientSort; title: string }> =
  PANEL_CLIENT_SORTS.map((key) => ({ key, title: CLIENT_SORT_TITLES[key] }));

/** Потолок поиска — тот же, что в репозитории. */
const MAX_QUERY_LENGTH = 100;

function parsePeriodDays(raw: string | undefined): AnalyticsPeriod | null {
  if (raw === undefined) return null;
  const days = Number(raw);
  return ANALYTICS_PERIODS.find((allowed) => allowed === days) ?? null;
}

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

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseClientsQuery(
  params: Record<string, string | string[] | undefined>,
): PanelClientsQuery {
  const ignored: string[] = [];

  const query = (firstValue(params.q)?.trim() ?? '').slice(0, MAX_QUERY_LENGTH);

  const rawSegment = firstValue(params.seg);
  const parsedSegment = rawSegment ? segmentSchema.safeParse(rawSegment) : null;
  if (rawSegment && !parsedSegment?.success) ignored.push('seg');

  const rawSort = firstValue(params.sort);
  const parsedSort = rawSort ? sortSchema.safeParse(rawSort) : null;
  if (rawSort && !parsedSort?.success) ignored.push('sort');

  const rawPeriod = firstValue(params.period);
  const period = parsePeriodDays(rawPeriod);
  if (rawPeriod && period === null) ignored.push('period');

  const rawPage = firstValue(params.page);
  const parsedPage = rawPage ? z.coerce.number().int().min(1).max(1000).safeParse(rawPage) : null;
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

/**
 * Исход клиента по заказам — то же деление, что у сегментов списка: строка
 * несёт пилюлю, а экран — счётчики, и они обязаны говорить одно и то же.
 */
export function clientKind(row: {
  ordersCount: number;
  purchasedCount: number;
}): 'buyer' | 'tried' | 'lurker' {
  if (row.purchasedCount > 0) return 'buyer';
  if (row.ordersCount > 0) return 'tried';
  return 'lurker';
}
