import { z } from 'zod';

import { getDb, markSupportRequestAnswered } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { invalidateMenuCounts } from '@/lib/panel/menu-counts';

/**
 * POST /api/panel/support/mark-answered — ручная отметка «отвечено».
 *
 * Клиенту ответили МИМО панели — личкой в Telegram по ссылке из карточки
 * клиента. Строки оператора в переписке от такого ответа нет, и обращение
 * висело бы «без ответа» бессрочно: в счётчике меню, на рабочем столе и у
 * сторожа крона, который напоминал бы о нём каждые четыре часа.
 *
 * ⚠️ Клиенту не уходит НИЧЕГО — этим отметка отличается от «Закрыть». Бота
 * роут не трогает вовсе, поэтому работает и для клиента без Telegram, и для
 * заблокировавшего бота.
 *
 * Отметить можно чужой разговор и разговор в любом режиме: правило «есть ли
 * что снимать» одно — то же, по которому список рисует кнопку
 * (`markSupportRequestAnswered`). Разговор у оператора отметка отпускает в
 * `idle`, как «Закрыть».
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

  const res = await markSupportRequestAnswered(getDb(), {
    conversationId,
    actorName: guard.actor.displayName,
  });

  if (res.status === 'not_found') {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (res.status === 'not_awaiting') {
    // Коллега успел ответить, закрыть или отметить — либо это вторая вкладка.
    // Отказ, а не тихий успех: экран у человека устарел, и он должен это узнать.
    return Response.json({ ok: false, error: 'not_awaiting' }, { status: 409 });
  }

  // Обращение снято — счётчик в меню обязан увидеть это на ближайшем
  // обновлении, а не через срок памятки.
  invalidateMenuCounts('support');

  log.info({ event: 'panel.support.marked_answered', staffId: guard.actor.id, mode: res.state.mode });
  return Response.json({ ok: true });
}
