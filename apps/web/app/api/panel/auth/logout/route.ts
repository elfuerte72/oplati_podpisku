import { childLogger } from '@/lib/logger';
import { clearPanelCookies, readPanelActor } from '@/lib/panel/session';

/**
 * POST /api/panel/auth/logout — выход из панели.
 *
 * Снимает обе cookie. Таблицы сессий нет, поэтому «выход» — это ровно снятие
 * токена у себя; отзыв доступа у другого сотрудника делается через
 * `staff.is_active` (проверяется на каждом запросе).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';

const log = childLogger('panel.auth');

export async function POST(): Promise<Response> {
  const actor = await readPanelActor();
  await clearPanelCookies();
  log.info({ event: 'panel.auth.signed_out', staffId: actor?.id ?? null });

  return new Response(null, { status: 303, headers: { Location: '/admin/login' } });
}
