import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { getDb, saveFunnelText } from '@oplati/db';

import { invalidateFunnelTexts } from '@/lib/funnel/texts';
import { childLogger } from '@/lib/logger';
import { checkFunnelTextForKey, funnelTextErrorResponse } from '@/lib/panel/funnel-texts';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';

/**
 * POST /api/panel/texts/save — сохранить переопределение текста воронки
 * (панель v2, ветка C, тикет 11).
 *
 * Ключ обязан быть в реестре (`400 unknown_key`), текст — пройти ту же
 * валидацию, что и тест-отправка (`422` с причиной). Сохранение пишет оверлей
 * и строку истории одной транзакцией (репозиторий) и сбрасывает памятку
 * реестра в этом процессе — крон и бот увидят новый текст сразу, а не через
 * минуту.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.texts');

const bodySchema = z.object({
  key: z.string().min(1).max(100),
  // Верхняя граница — лимит сообщения Telegram с запасом; точный лимит ключа
  // проверяет реестр.
  value: z.string().max(8192),
});

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('texts');
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
  let check: Awaited<ReturnType<typeof checkFunnelTextForKey>>;
  try {
    check = await checkFunnelTextForKey(db, body.key, body.value);
  } catch (err) {
    // Проверка читает соседей из БД: отказ базы — 503, а не 500.
    log.error({ event: 'panel.texts.check_failed', staffId: guard.actor.id, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
  if (!check.ok) return funnelTextErrorResponse(check);

  try {
    await saveFunnelText(db, { key: check.spec.key, value: check.value, staffId: guard.actor.id });
  } catch (err) {
    log.error({ event: 'panel.texts.save_failed', staffId: guard.actor.id, key: check.spec.key, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  invalidateFunnelTexts();
  log.info({ event: 'panel.texts.saved', staffId: guard.actor.id, key: check.spec.key });
  return Response.json({ ok: true });
}
