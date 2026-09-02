import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { getDb, resetFunnelText } from '@oplati/db';

import { funnelTextSpec, invalidateFunnelTexts } from '@/lib/funnel/texts';
import { childLogger } from '@/lib/logger';
import { checkFunnelTextForKey, funnelTextErrorResponse } from '@/lib/panel/funnel-texts';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';

/**
 * POST /api/panel/texts/reset — вернуть тексту дефолт из кода (тикет 11).
 * Удаляет переопределение и пишет в историю `new_value NULL`; без
 * переопределения — идемпотентный no-op (`changed: false`).
 *
 * Возвращаемый дефолт проходит ТУ ЖЕ проверку, что и сохранение: он тоже
 * становится живым текстом рядом с переопределёнными соседями, и без проверки
 * сброс подписи ответа мог вернуть кнопку с подписью, которую сосед уже занял
 * (два одинаковых «Другое» с разными `callback_data` — клик клиента
 * записывался бы не в тот ответ, code-review 2026-09-02).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 15;

const log = childLogger('panel.texts');

const bodySchema = z.object({ key: z.string().min(1).max(100) });

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

  const spec = funnelTextSpec(body.key);
  if (!spec) return Response.json({ ok: false, error: 'unknown_key' }, { status: 400 });

  const db = getDb();
  let check: Awaited<ReturnType<typeof checkFunnelTextForKey>>;
  try {
    check = await checkFunnelTextForKey(db, spec.key, spec.defaultValue);
  } catch (err) {
    // Проверка читает соседей из БД: отказ базы — 503, а не 500.
    log.error({ event: 'panel.texts.check_failed', staffId: guard.actor.id, key: spec.key, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
  if (!check.ok) return funnelTextErrorResponse(check);

  let changed: boolean;
  try {
    ({ changed } = await resetFunnelText(db, { key: spec.key, staffId: guard.actor.id }));
  } catch (err) {
    log.error({ event: 'panel.texts.reset_failed', staffId: guard.actor.id, key: spec.key, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  invalidateFunnelTexts();
  log.info({ event: 'panel.texts.reset', staffId: guard.actor.id, key: spec.key, changed });
  return Response.json({ ok: true, changed });
}
