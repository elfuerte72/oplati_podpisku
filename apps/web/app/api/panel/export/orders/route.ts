import { getDb, listOrdersForPanel } from '@oplati/db';

import { periodBounds } from '@/lib/panel/analytics/period';
import { buildCsv, csvFilename } from '@/lib/panel/csv';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { EXPORT_COLUMNS } from '@/lib/panel/labels';
import { parseOrdersQuery } from '@/lib/panel/order-filters';
import { EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, exportOrderRow } from '@/lib/panel/export';

/**
 * POST /api/panel/export/orders — выгрузка списка заказов в CSV (панель v3).
 *
 * ⚠️ POST обычной формой, а не ссылка с `?q=`: фильтр заказов ищет по почте и
 * телефону клиента, а адрес попадает в историю браузера и в `Referer`. Форма
 * шлёт `application/x-www-form-urlencoded`, поэтому требование JSON здесь
 * снято — гейт `Origin` остаётся (он и защищает от запроса с чужого сайта).
 *
 * Фильтры разбираются ТЕМ ЖЕ `parseOrdersQuery`, что и экран: выгрузка обязана
 * содержать ровно то, что человек видит на экране, иначе ей нельзя верить.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req, { requireJson: false }))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('orders');
  if (!guard.ok) return panelGuardResponse(guard);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }

  const params: Record<string, string> = {};
  for (const key of ['q', 's', 'status', 'sort', 'period'] as const) {
    const value = form.get(key);
    if (typeof value === 'string') params[key] = value;
  }
  const filters = parseOrdersQuery(params);
  const statuses = filters.status ? [filters.status] : filters.preset.statuses;
  const window = filters.period ? periodBounds(filters.period, new Date()) : null;

  const db = getDb();
  const rows: string[][] = [];
  // Страницами: потолок выборки стоит в репозитории (панель делит процесс с
  // вебхуками, принимающими деньги), поэтому «выгрузить всё» — это несколько
  // обычных страниц, а не один запрос без предела.
  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_PAGE_SIZE) {
    const page = await listOrdersForPanel(db, {
      statuses,
      query: filters.query || undefined,
      sort: filters.sort,
      createdFrom: window?.since,
      createdTo: window?.until,
      limit: EXPORT_PAGE_SIZE,
      offset,
    });
    rows.push(...page.items.map(exportOrderRow));
    if (!page.hasMore) break;
  }

  const csv = buildCsv(EXPORT_COLUMNS.orders, rows);

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFilename('orders', new Date())}"`,
      // Выгрузка содержит контакты клиентов: ни прокси, ни браузер её не
      // хранят.
      'cache-control': 'no-store',
    },
  });
}
