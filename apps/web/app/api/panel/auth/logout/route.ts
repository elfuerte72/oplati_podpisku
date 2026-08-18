import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin } from '@/lib/panel/guard';
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

export async function POST(req: Request): Promise<Response> {
  // Правило «мутирующая операция панели сверяет Origin» — без исключений:
  // иначе любая страница на соседнем поддомене разлогинивает менеджера скрытой
  // формой. Ущерб небольшой, но исключение из правила делает правилом другое.
  if (!(await assertPanelRequestOrigin(req, { requireJson: false }))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const actor = await readPanelActor();
  await clearPanelCookies();
  log.info({ event: 'panel.auth.signed_out', staffId: actor?.id ?? null });

  return new Response(null, { status: 303, headers: { Location: '/admin/login' } });
}
