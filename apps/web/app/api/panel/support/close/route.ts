import { z } from 'zod';

import { getDb, getSupportThreadForPanel, transitionConversationMode } from '@oplati/db';

import { trackServer } from '@/lib/analytics/track';
import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { invalidateMenuCounts } from '@/lib/panel/menu-counts';
import { SUPPORT_CLOSED_BY_OPERATOR } from '@/lib/support/texts';
import { getBot } from '@/lib/telegram/bot';

/**
 * POST /api/panel/support/close — «Закрыть» (тикет 07).
 *
 * `operator → idle` из любого режима оператора: ведущий и срок снимаются,
 * клиенту — «оператор завершил обращение». Чужой разговор закрыть можно: это
 * способ его завершить, а не перехватить (в отличие от ответа).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.support');

const bodySchema = z.object({ conversationId: z.string().uuid() });

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('support');
  if (!guard.ok) return panelGuardResponse(guard);

  let conversationId: string;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    conversationId = parsed.data.conversationId;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const db = getDb();
  const thread = await getSupportThreadForPanel(db, conversationId, 1);
  if (!thread) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const res = await transitionConversationMode(db, {
    conversationId,
    from: 'operator',
    to: 'idle',
    trigger: 'operator_close',
    reason: guard.actor.displayName,
    modeExpiresAt: null,
    assignedOperatorId: null,
  });
  if (!res.transitioned) {
    return Response.json({ ok: false, error: 'not_in_operator_mode' }, { status: 409 });
  }

  if (thread.client.telegramId) {
    try {
      await getBot().api.sendMessage(thread.client.telegramId, SUPPORT_CLOSED_BY_OPERATOR);
    } catch (err) {
      log.warn({ event: 'panel.support.close_notify_failed', staffId: guard.actor.id, err });
    }
  }

  trackServer({
    name: 'support_session_closed',
    telegramId: thread.client.telegramId,
    props: { stage: 'operator' },
    eventKey: `panel-close-${conversationId}-${Date.now()}`,
  });

  // Закрытое обращение больше не «без ответа» — счётчик в меню обязан это
  // увидеть на ближайшем обновлении.
  invalidateMenuCounts('support');

  log.info({ event: 'panel.support.closed', staffId: guard.actor.id });
  return Response.json({ ok: true });
}
