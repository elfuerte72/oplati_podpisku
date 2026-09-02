import { z } from 'zod';

import {
  ANALYST_HISTORY_MAX_TURNS,
  ANALYST_QUESTION_MAX,
  analystTurnSchema,
  askAnalyst,
} from '@/lib/panel/ai/ask';
import { assertPanelRequestOrigin, guardPanelOperation, panelGuardResponse } from '@/lib/panel/guard';

/**
 * POST /api/panel/ai/ask — вопрос AI-аналитику (спека admin-panel-v2, ветка B,
 * тикет 07).
 *
 * Гейт `Origin` + `application/json` — как у всех МУТИРУЮЩИХ операций панели,
 * хотя в БД ничего не пишется: каждый вопрос стоит денег провайдеру, и
 * инъекция на публичном сайте не должна гонять модель за наш счёт.
 *
 * Чат эфемерный: история приходит в теле, сервер не хранит ничего. Sentry —
 * только внутри `askAnalyst` на неожиданных отказах; кап и «не настроено» —
 * штатные коды ответа.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
// Восемь итераций модели с запросами к базе — минуты хватает с запасом, а
// дефолтные 15 с обрывали бы честный ход на третьем запросе.
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().trim().min(1).max(ANALYST_QUESTION_MAX),
  history: z.array(analystTurnSchema).max(ANALYST_HISTORY_MAX_TURNS).default([]),
});

const STATUS_BY_REASON = {
  not_configured: 503,
  rate_limited: 429,
  model_failed: 502,
  // Кап итераций — не авария: модель честно не уложилась, экран это объяснит.
  max_iterations: 200,
  invalid_history: 400,
} as const;

export async function POST(req: Request): Promise<Response> {
  if (!(await assertPanelRequestOrigin(req))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const guard = await guardPanelOperation('ai');
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

  const result = await askAnalyst({
    staffId: guard.actor.id,
    question: body.question,
    history: body.history,
  });

  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.reason, toolCalls: result.toolCalls, usage: result.usage },
      { status: STATUS_BY_REASON[result.reason] },
    );
  }

  return Response.json({
    ok: true,
    answer: result.answer,
    toolCalls: result.toolCalls,
    usage: result.usage,
    incomplete: result.incomplete,
  });
}
