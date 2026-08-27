import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { appendMessage, getDb, getSupportThreadForPanel } from '@oplati/db';

import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';
import { invalidateMenuCounts } from '@/lib/panel/menu-counts';
import { SUPPORT_REPLY_MAX, SUPPORT_REPLY_MIN, supportReplyBlockReason } from '@/lib/panel/support';
import { getBot } from '@/lib/telegram/bot';
import { redactCardNumbers } from '@/lib/telegram/templates';

/**
 * POST /api/panel/support/reply — ответ клиенту из панели (тикет 10, спека §6.3).
 *
 * ⚠️ Клиенту ответ приходит ОТ БОТА, через СУЩЕСТВУЮЩЕГО клиентского бота: что
 * за ботом живой человек, клиент не знает, и второго канала связи мы не заводим.
 *
 * ⚠️ Текст оператора проходит `redactCardNumbers` при записи — как клиентский.
 * Оператор может процитировать номер карты из обращения, а политика «полный PAN
 * не оседает в базе» от направления сообщения не зависит.
 *
 * Порядок «отправили → записали» намеренный: строка в переписке — это ЗАПИСЬ
 * произошедшего. Записать раньше отправки значило бы показать следующему
 * менеджеру ответ, которого клиент не получал, и тот не стал бы отвечать.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.support');

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string().trim().min(SUPPORT_REPLY_MIN).max(SUPPORT_REPLY_MAX),
});

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('support');
  if (!guard.ok) return panelGuardResponse(guard);

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const db = getDb();
  const thread = await getSupportThreadForPanel(db, body.conversationId, 1);
  if (!thread) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const blocked = supportReplyBlockReason({
    clientTelegramId: thread.client.telegramId,
    assignedOperatorId: thread.assignedOperatorId,
    actorId: guard.actor.id,
  });
  if (blocked) {
    log.warn({ event: 'panel.support.blocked', staffId: guard.actor.id, reason: blocked });
    return Response.json({ ok: false, error: blocked }, { status: 409 });
  }

  const telegramId = thread.client.telegramId;
  if (!telegramId) return Response.json({ ok: false, error: 'no_telegram' }, { status: 409 });

  // Маскируем ДО отправки: и в Telegram, и в базу уходит один и тот же текст,
  // иначе клиент видит номер карты, которого в истории нет.
  const text = redactCardNumbers(body.text);

  // ⚠️ `getBot()` — ОТДЕЛЬНЫМ шагом. Он бросает при незаданном
  // `TELEGRAM_BOT_TOKEN`, и внутри общего `try` эта авария конфигурации
  // выдавалась бы за «клиент заблокировал бота»: менеджер видел бы отказ
  // клиента по каждому диалогу подряд и пошёл бы разбираться не туда.
  let bot: ReturnType<typeof getBot>;
  try {
    bot = getBot();
  } catch (err) {
    log.error({ event: 'panel.support.bot_unavailable', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.support' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  try {
    await bot.api.sendMessage(telegramId, text);
  } catch (err) {
    // Чаще всего — клиент заблокировал бота. Менеджер обязан это увидеть, а не
    // считать, что ответил.
    log.warn({ event: 'panel.support.send_failed', staffId: guard.actor.id, err });
    return Response.json({ ok: false, error: 'send_failed' }, { status: 502 });
  }

  try {
    await appendMessage(db, {
      conversationId: body.conversationId,
      role: 'operator',
      staffId: guard.actor.id,
      content: text,
      meta: { source: 'panel' },
    });
  } catch (err) {
    // Сообщение УЖЕ у клиента. Потеря строки означает, что следующий менеджер
    // не увидит ответа и напишет второй раз — это надо видеть.
    log.error({ event: 'panel.support.reply_not_recorded', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.support', step: 'record' } });
    return Response.json({ ok: true, warning: 'not_recorded' });
  }

  // Ответ записан — «без ответа» изменилось; счётчик в меню обязан увидеть это
  // на ближайшем `router.refresh()`, а не через срок памятки.
  invalidateMenuCounts('support');

  log.info({ event: 'panel.support.replied', staffId: guard.actor.id });
  return Response.json({ ok: true });
}
