import { z } from 'zod';

import { claimSupportConversation, getDb } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';

/**
 * POST /api/panel/support/assign — «подключиться к диалогу» (тикет 10).
 *
 * Ставит `conversations.handoff_mode = 'operator'` и `assigned_operator_id`.
 * Поля есть в схеме с самого начала и до сих пор не использовались.
 *
 * ⚠️ Захват атомарный и НЕ перебивает чужой: два менеджера, отвечающие одному
 * клиенту, — худший исход, чем задержка. Проигравший получает 409, а не молчание.
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

  const claimed = await claimSupportConversation(getDb(), {
    conversationId,
    staffId: guard.actor.id,
  });
  if (claimed === 'not_found') {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (claimed === 'taken') {
    log.warn({ event: 'panel.support.assign_taken', staffId: guard.actor.id });
    return Response.json({ ok: false, error: 'assigned_to_other' }, { status: 409 });
  }

  log.info({ event: 'panel.support.assigned', staffId: guard.actor.id });
  return Response.json({ ok: true });
}
