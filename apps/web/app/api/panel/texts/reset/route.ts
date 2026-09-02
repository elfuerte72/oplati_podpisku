import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { getDb, resetFunnelText } from '@oplati/db';

import { funnelTextSpec, invalidateFunnelTexts } from '@/lib/funnel/texts';
import { childLogger } from '@/lib/logger';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';

/**
 * POST /api/panel/texts/reset — вернуть тексту дефолт из кода (тикет 11).
 * Удаляет переопределение и пишет в историю `new_value NULL`; без
 * переопределения — идемпотентный no-op (`changed: false`).
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

  let changed: boolean;
  try {
    ({ changed } = await resetFunnelText(getDb(), { key: spec.key, staffId: guard.actor.id }));
  } catch (err) {
    log.error({ event: 'panel.texts.reset_failed', staffId: guard.actor.id, key: spec.key, err });
    Sentry.captureException(err, { tags: { source: 'panel.texts' } });
    return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  invalidateFunnelTexts();
  log.info({ event: 'panel.texts.reset', staffId: guard.actor.id, key: spec.key, changed });
  return Response.json({ ok: true, changed });
}
