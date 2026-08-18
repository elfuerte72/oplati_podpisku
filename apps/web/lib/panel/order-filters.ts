import { z } from 'zod';

import { PANEL_PENDING_ORDER_STATUSES, type PanelOrderSort } from '@oplati/db';
import { orderStatus, type OrderStatus } from '@oplati/types';

/**
 * Разбор адреса экрана заказов. Параметры адреса — граница (инвариант 5),
 * поэтому Zod, а не «взять что дали».
 *
 * Фильтры живут В АДРЕСЕ намеренно (спека §5.2): ссылку на нужную выборку можно
 * переслать коллеге. Отсюда же требование к разбору — он обязан быть
 * предсказуемым: непонятый параметр не «молча показывает всё», а честно
 * откатывается к значению по умолчанию, о чём экран говорит вслух.
 */

/** Готовые наборы статусов — то, что спрашивают чаще всего. */
export const STATUS_PRESETS = [
  { key: 'all', title: 'Все', statuses: [] },
  {
    key: 'live',
    title: 'В работе',
    statuses: ['ready_for_payment', 'pending_payment', 'payment_review', 'paid', 'in_fulfillment'],
  },
  // Тот же набор, что у экрана `/admin/pending`: два определения «недожатых» в
  // одной панели означали бы два разных списка под одним словом.
  { key: 'unpaid', title: 'Недожатые', statuses: PANEL_PENDING_ORDER_STATUSES },
  { key: 'review', title: 'Холд банка', statuses: ['payment_review'] },
  { key: 'failed', title: 'Провалились', statuses: ['failed'] },
  { key: 'completed', title: 'Выполнены', statuses: ['completed'] },
] as const satisfies ReadonlyArray<{
  key: string;
  title: string;
  statuses: readonly OrderStatus[];
}>;

export type StatusPresetKey = (typeof STATUS_PRESETS)[number]['key'];

const presetKeySchema = z.enum(
  STATUS_PRESETS.map((p) => p.key) as [StatusPresetKey, ...StatusPresetKey[]],
);

const sortSchema = z.enum(['newest', 'oldest', 'amount_desc', 'amount_asc']);

export const SORT_OPTIONS: ReadonlyArray<{ key: PanelOrderSort; title: string }> = [
  { key: 'newest', title: 'Свежие' },
  { key: 'oldest', title: 'Старые' },
  { key: 'amount_desc', title: 'Дорогие' },
  { key: 'amount_asc', title: 'Дешёвые' },
];

/** Потолок поиска — тот же, что в репозитории; длиннее вводить незачем. */
const MAX_QUERY_LENGTH = 100;

export type PanelOrdersQuery = {
  query: string;
  preset: (typeof STATUS_PRESETS)[number];
  /** Точечный статус из адреса (ссылка из другого экрана панели). */
  status: OrderStatus | null;
  sort: PanelOrderSort;
  page: number;
  /** Какие параметры адреса не разобрались — экран скажет об этом вслух. */
  ignored: string[];
};

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseOrdersQuery(
  params: Record<string, string | string[] | undefined>,
): PanelOrdersQuery {
  const ignored: string[] = [];

  const rawQuery = firstValue(params.q)?.trim() ?? '';
  const query = rawQuery.slice(0, MAX_QUERY_LENGTH);

  const rawStatus = firstValue(params.status);
  const parsedStatus = rawStatus ? orderStatus.safeParse(rawStatus) : null;
  if (rawStatus && !parsedStatus?.success) ignored.push('status');

  const rawPreset = firstValue(params.s);
  const parsedPreset = rawPreset ? presetKeySchema.safeParse(rawPreset) : null;
  if (rawPreset && !parsedPreset?.success) ignored.push('s');

  const rawSort = firstValue(params.sort);
  const parsedSort = rawSort ? sortSchema.safeParse(rawSort) : null;
  if (rawSort && !parsedSort?.success) ignored.push('sort');

  const rawPage = firstValue(params.page);
  const parsedPage = rawPage ? z.coerce.number().int().min(1).max(1000).safeParse(rawPage) : null;
  if (rawPage && !parsedPage?.success) ignored.push('page');

  const presetKey = parsedPreset?.success ? parsedPreset.data : 'all';
  const preset = STATUS_PRESETS.find((p) => p.key === presetKey) ?? STATUS_PRESETS[0];

  return {
    query,
    preset,
    status: parsedStatus?.success ? parsedStatus.data : null,
    sort: parsedSort?.success ? parsedSort.data : 'newest',
    page: parsedPage?.success ? parsedPage.data : 1,
    ignored,
  };
}

/**
 * Номер заказа из адреса. Формат задаётся генератором (`ORD-` + пять символов
 * алфавита без похожих букв), поэтому проверяем его схемой, а не отправляем
 * произвольную строку в запрос.
 */
export const orderShortIdSchema = z
  .string()
  .trim()
  .regex(/^ORD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/i, 'not an order number');

/** Собрать адрес экрана заказов из состояния фильтров. */
export function ordersHref(
  state: Partial<Pick<PanelOrdersQuery, 'query' | 'sort' | 'page'>> & {
    presetKey?: StatusPresetKey;
    status?: OrderStatus | null;
  },
): { pathname: string; query: Record<string, string> } {
  const query: Record<string, string> = {};
  if (state.presetKey && state.presetKey !== 'all') query.s = state.presetKey;
  if (state.status) query.status = state.status;
  if (state.query) query.q = state.query;
  if (state.sort && state.sort !== 'newest') query.sort = state.sort;
  if (state.page && state.page > 1) query.page = String(state.page);
  return { pathname: '/admin/orders', query };
}
