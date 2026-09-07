import { z } from 'zod';

import { getDb, getSupportThreadForPanel, transitionConversationMode } from '@oplati/db';

import { trackServer } from '@/lib/analytics/track';
import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { invalidateMenuCounts } from '@/lib/panel/menu-counts';
import { canReturnToAi } from '@/lib/panel/permissions';
import { sessionDeadline } from '@/lib/support/session';
import { SUPPORT_RETURNED_TO_AI } from '@/lib/support/texts';
import { getBot } from '@/lib/telegram/bot';

/**
 * POST /api/panel/support/return — «Вернуть помощнику» (тикет 07).
 *
 * `operator → ai`: ведущий снимается, помощник снова ведёт рутину, клиенту —
 * «оператор передал диалог помощнику». Доступно ведущему и админу: решение
 * «я закончил» принимает тот, кто вёл, админ — на случай ушедшего в отпуск.
 *
 * Уведомление клиенту best-effort: переход состоялся независимо от доставки.
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

  if (
    !canReturnToAi({
      actorId: guard.actor.id,
      actorRole: guard.actor.role,
      assignedOperatorId: thread.assignedOperatorId,
    })
  ) {
    log.warn({ event: 'panel.support.return_forbidden', staffId: guard.actor.id });
    return Response.json({ ok: false, error: 'assigned_to_other' }, { status: 409 });
  }

  const res = await transitionConversationMode(db, {
    conversationId,
    from: 'operator',
    to: 'ai',
    trigger: 'operator_return',
    actorName: guard.actor.displayName,
    modeExpiresAt: sessionDeadline(new Date()),
    assignedOperatorId: null,
    // Владение — В ПРЕДИКАТЕ UPDATE, а не только в `canReturnToAi` выше:
    // между проверкой и переходом разговор мог захватить коллега, и вернуть
    // помощнику чужой разговор нельзя. Админу — можно любой.
    onlyIfFreeOrOwnedBy: guard.actor.role === 'admin' ? undefined : guard.actor.id,
  });
  if (!res.transitioned) {
    // Разговор уже не у оператора — вернуть нечего. Не ошибка: кнопку нажали
    // на устаревшей странице.
    return Response.json({ ok: false, error: 'not_in_operator_mode' }, { status: 409 });
  }
  // Возврат помощнику снимает обращение с «без ответа» — счётчик меню обязан
  // это показать следующим же рендером, а не после срока памятки.
  invalidateMenuCounts('support');

  if (thread.client.telegramId) {
    try {
      await getBot().api.sendMessage(thread.client.telegramId, SUPPORT_RETURNED_TO_AI);
    } catch (err) {
      log.warn({ event: 'panel.support.return_notify_failed', staffId: guard.actor.id, err });
    }
  }

  trackServer({
    name: 'support_returned_to_ai',
    telegramId: thread.client.telegramId,
    eventKey: `panel-return-${conversationId}-${Date.now()}`,
  });

  log.info({ event: 'panel.support.returned_to_ai', staffId: guard.actor.id });
  return Response.json({ ok: true });
}
