import { z } from 'zod';

import { getDb, listOrdersForPanel, searchClientsForPanel } from '@oplati/db';

import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { PANEL_SEARCH_LIMIT, PANEL_SEARCH_MIN_LENGTH } from '@/lib/panel/search';

/**
 * POST /api/panel/search — быстрый поиск по заказам и клиентам (панель v3).
 *
 * ⚠️ POST, а не `GET ?q=`, хотя запрос ничего не меняет. Ищут здесь по почте и
 * телефону клиента, а адрес попадает в историю браузера, в заголовок `Referer`
 * и в отчёт об ошибке. Экран заказов уже стоил нам отдельного правила в
 * денилисте Sentry, чистящего `query_string` и `request.url`; заводить второе
 * такое место незачем.
 *
 * Поэтому же здесь стоит гейт `Origin` + `application/json`, обычно
 * защищающий мутации: для чтения он не про запись, а про то, чтобы страница
 * чужого сайта не могла спрашивать нашу базу за спиной вошедшего сотрудника.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const bodySchema = z.object({ query: z.string().min(1).max(100) });

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  // Право на заказы: выдача — это заказы и клиенты, а карточка клиента и
  // список заказов открыты одной и той же роли. Отдельного права у поиска нет
  // намеренно — иначе он показывал бы то, чего экран не покажет.
  const guard = await guardPanelOperation('orders');
  if (!guard.ok) return panelGuardResponse(guard);

  let query: string;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    query = parsed.data.query.trim();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // Один символ находит половину базы и греет её на каждое нажатие клавиши.
  if (query.length < PANEL_SEARCH_MIN_LENGTH) {
    return Response.json({ ok: true, orders: [], clients: [] });
  }

  const db = getDb();
  const [ordersPage, clients] = await Promise.all([
    listOrdersForPanel(db, { query, limit: PANEL_SEARCH_LIMIT, sort: 'newest' }),
    searchClientsForPanel(db, { query, limit: PANEL_SEARCH_LIMIT }),
  ]);

  return Response.json({
    ok: true,
    orders: ordersPage.items.map((order) => ({
      shortId: order.shortId,
      status: order.status,
      amountRubKopecks: order.amountRubKopecks,
      serviceName: order.serviceName,
      clientName: order.client.displayName,
    })),
    clients: clients.map((client) => ({
      id: client.id,
      displayName: client.displayName,
      telegramId: client.telegramId,
      email: client.email,
    })),
  });
}
