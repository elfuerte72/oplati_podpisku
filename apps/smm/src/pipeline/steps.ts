import { layoutFor, smmConfig, type RubricKey } from '../config/smm.config.ts';
import { DossierSchema, PlanSchema, type Dossier, type Plan } from '../llm/schemas.ts';
import { dossierInput, planInput, writeInput } from './inputs.ts';
import type { Advice, PipelineDeps, StepResult } from './types.ts';

/**
 * Шаги конвейера, каждый из которых зовёт модель ровно один раз.
 *
 * Порядок шагов фиксирован в коде: модель пишет и оценивает, но не выбирает,
 * что делать дальше. Каждый шаг логирует `started` и `done`/`failed` — по этим
 * строкам в Loki видно, где конвейер встал.
 */

export interface StepLogContext {
  readonly postId?: string;
  readonly step: string;
}

function started(deps: PipelineDeps, ctx: StepLogContext): void {
  deps.logger.info({ ...ctx, status: 'started' }, 'шаг конвейера');
}

function done(deps: PipelineDeps, ctx: StepLogContext, ms: number): void {
  deps.logger.info({ ...ctx, status: 'done', ms }, 'шаг конвейера');
}

function failed(deps: PipelineDeps, ctx: StepLogContext, reason: string, ms: number): void {
  deps.logger.warn({ ...ctx, status: 'failed', reason, ms }, 'шаг конвейера');
}

export interface ArticleInput {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export async function buildDossier(
  article: ArticleInput,
  deps: PipelineDeps,
  options: { postId?: string } = {},
): Promise<StepResult<Dossier>> {
  const ctx: StepLogContext = {
    step: 'dossier',
    ...(options.postId === undefined ? {} : { postId: options.postId }),
  };
  if (article.text.trim().length < 200) {
    // Без текста статьи досье собрать нечего, а выдумывать факты нельзя.
    return { ok: false, reason: 'empty_source', message: 'в статье нет текста для разбора' };
  }
  started(deps, ctx);
  const at = Date.now();
  const answer = await deps.model.json('dossier', dossierInput(article), DossierSchema, {
    ...(options.postId === undefined ? {} : { postId: options.postId }),
  });
  if (!answer.ok) {
    failed(deps, ctx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  done(deps, ctx, Date.now() - at);
  return { ok: true, value: answer.value };
}

export async function plan(
  input: { dossier: Dossier; advice?: Advice; seenAngles?: readonly string[]; postId?: string },
  deps: PipelineDeps,
): Promise<StepResult<Plan>> {
  const ctx: StepLogContext = {
    step: 'plan',
    ...(input.postId === undefined ? {} : { postId: input.postId }),
  };
  started(deps, ctx);
  const at = Date.now();
  const answer = await deps.model.json(
    'plan',
    planInput({
      dossier: input.dossier,
      ...(input.advice === undefined ? {} : { advice: input.advice }),
      ...(input.seenAngles === undefined ? {} : { seenAngles: input.seenAngles }),
      ...(deps.config === undefined ? {} : { config: deps.config }),
    }),
    PlanSchema,
    { ...(input.postId === undefined ? {} : { postId: input.postId }) },
  );
  if (!answer.ok) {
    failed(deps, ctx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  done(deps, ctx, Date.now() - at);
  if (answer.value.nothing_changes) {
    // «Для читателя ничего не меняется» поднимается НАВЕРХ до текста: владелец
    // решит, брать другую тему или писать всё равно. Денег на текст не тратим.
    return {
      ok: false,
      reason: 'nothing_changes',
      message: answer.value.note ?? 'для читателя ничего не меняется',
    };
  }
  return { ok: true, value: answer.value };
}

export async function writeDraft(
  input: {
    dossier: Dossier;
    rubric: RubricKey;
    angle: string;
    advice: Advice;
    postId?: string;
  },
  deps: PipelineDeps,
): Promise<StepResult<string>> {
  const config = deps.config ?? smmConfig;
  const layout = layoutFor(input.rubric).key;
  const ctx: StepLogContext = {
    step: 'write',
    ...(input.postId === undefined ? {} : { postId: input.postId }),
  };
  started(deps, ctx);
  const at = Date.now();
  const answer = await deps.model.markdown(
    'write',
    writeInput({
      dossier: input.dossier,
      rubric: input.rubric,
      layout,
      angle: input.angle,
      advice: input.advice,
      config,
    }),
    { ...(input.postId === undefined ? {} : { postId: input.postId }) },
  );
  if (!answer.ok) {
    failed(deps, ctx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  done(deps, ctx, Date.now() - at);
  return { ok: true, value: answer.value };
}

export { started as logStepStarted, done as logStepDone, failed as logStepFailed };
