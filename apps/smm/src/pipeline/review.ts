import { smmConfig } from '../config/smm.config.ts';
import { lintPost } from '../lint/post.ts';
import { formatLint, lintPassed } from '../lint/report.ts';
import { lintThreads } from '../lint/threads.ts';
import type { LintResult, PreviousPost } from '../lint/types.ts';
import { evaluateJudge, formatJudge, type JudgeVerdict } from '../llm/judge.ts';
import { judgeSchema } from '../llm/schemas.ts';
import { judgeInput, reviseInput } from './inputs.ts';
import { logStepDone, logStepFailed, logStepStarted } from './steps.ts';
import type { HistoryPost, PipelineDeps, ReviewContext, ReviewedDraft, StepResult } from './types.ts';

/**
 * Проверка черновика: линт, круг правок, редактор, ещё круги.
 *
 * Порядок не случаен. Линт — КОД и первый гейт: он ловит то, что модель
 * забывает из раза в раз, и стоит дешевле вызова редактора. Редактор — второй
 * гейт, и его «против» не выбрасывает пост, а доходит до владельца вместе с
 * оценкой (история 16 спеки).
 *
 * Текст владельца редактору не показывается вовсе: бот не «улучшает» человека.
 */

function toPrevious(posts: readonly HistoryPost[] | undefined): PreviousPost[] {
  return (posts ?? []).map((post) => ({ id: post.id, body: post.body }));
}

function runLint(body: string, ctx: ReviewContext, config = smmConfig): LintResult {
  if (ctx.platform === 'threads') {
    return lintThreads(body, {
      cta: ctx.cta,
      config,
      ...(ctx.tag === undefined ? {} : { tag: ctx.tag }),
      previous: toPrevious(ctx.previous),
      channelPrevious: toPrevious(ctx.channelPrevious),
    });
  }
  return lintPost(body, {
    layout: ctx.layout,
    cta: ctx.cta,
    hasImage: ctx.hasImage,
    previous: toPrevious(ctx.previous),
    config,
  });
}

async function revise(
  body: string,
  problems: string,
  ctx: ReviewContext,
  deps: PipelineDeps,
): Promise<StepResult<string>> {
  const config = deps.config ?? smmConfig;
  const logCtx = {
    step: 'revise',
    ...(ctx.postId === undefined ? {} : { postId: ctx.postId }),
  };
  logStepStarted(deps, logCtx);
  const at = Date.now();
  const answer = await deps.model.markdown(
    'revise',
    reviseInput({
      body,
      problems,
      layout: ctx.layout,
      platform: ctx.platform,
      config,
      ...(ctx.dossier === undefined ? {} : { dossier: ctx.dossier }),
    }),
    { ...(ctx.postId === undefined ? {} : { postId: ctx.postId }) },
  );
  if (!answer.ok) {
    logStepFailed(deps, logCtx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  logStepDone(deps, logCtx, Date.now() - at);
  return { ok: true, value: answer.value };
}

/**
 * Оценка редактора отдельным вызовом. Отдельно от `review`, потому что её
 * зовёт калибровка: там нужен только вердикт, без кругов правок и публикации.
 */
export async function judgePost(
  body: string,
  ctx: ReviewContext,
  deps: PipelineDeps,
): Promise<StepResult<JudgeVerdict>> {
  const config = deps.config ?? smmConfig;
  const rules = ctx.platform === 'threads' ? config.judge.threads : config.judge.telegram;
  const logCtx = {
    step: 'judge',
    ...(ctx.postId === undefined ? {} : { postId: ctx.postId }),
  };
  logStepStarted(deps, logCtx);
  const at = Date.now();
  const answer = await deps.model.json(
    'judge',
    judgeInput({
      body,
      rubric: ctx.rubric,
      cta: ctx.cta,
      platform: ctx.platform,
      config,
      ...(ctx.angle === undefined ? {} : { angle: ctx.angle }),
      ...(ctx.dossier === undefined ? {} : { dossier: ctx.dossier }),
    }),
    judgeSchema(rules.criteria),
    { ...(ctx.postId === undefined ? {} : { postId: ctx.postId }) },
  );
  if (!answer.ok) {
    logStepFailed(deps, logCtx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  const verdict = evaluateJudge(answer.value, body, config);
  logStepDone(deps, { ...logCtx, step: 'judge' }, Date.now() - at);
  deps.logger.info(
    {
      step: 'judge',
      ...(ctx.postId === undefined ? {} : { postId: ctx.postId }),
      mean: verdict.mean,
      verdict: verdict.verdict,
      unverifiedNotes: verdict.unverifiedNotes,
    },
    'оценка редактора',
  );
  return { ok: true, value: verdict };
}

export async function review(
  draft: string,
  ctx: ReviewContext,
  deps: PipelineDeps,
): Promise<StepResult<ReviewedDraft>> {
  const config = deps.config ?? smmConfig;
  let body = draft;
  let rounds = 0;

  // --- текст владельца уходит ДОСЛОВНО: модель его не переписывает.
  // ⚠️ Гейт стоит ПЕРВЫМ, а не после круга правок по линту: ниже он спасал
  // текст только от редактора, а негодный по линту текст владельца модель всё
  // равно переписывала — при обещании «уйдёт дословно» на экране. Линт при
  // этом считается: владельцу говорят, что не так, и он решает сам.
  if (ctx.ownerText === true) {
    const ownLint = runLint(body, ctx, config);
    return {
      ok: true,
      value: lintPassed(ownLint)
        ? { body, lint: ownLint, rounds, verdict: 'pass' }
        : { body, lint: ownLint, rounds, verdict: 'fail', failedBy: 'lint' },
    };
  }

  // --- первый гейт: линт. Круг правок по нему ровно один.
  let lint = runLint(body, ctx, config);
  if (!lintPassed(lint)) {
    const fixed = await revise(body, formatLint(lint), ctx, deps);
    if (!fixed.ok) return fixed;
    rounds += 1;
    body = fixed.value;
    lint = runLint(body, ctx, config);
    if (!lintPassed(lint)) {
      // Второй провал линта — владельцу, с отчётом. Гонять модель по кругу
      // дальше значит платить за то, что она уже не исправила.
      return {
        ok: true,
        value: { body, lint, rounds, verdict: 'fail', failedBy: 'lint' },
      };
    }
  }

  // --- второй гейт: редактор. До двух кругов правок.
  let judge = await judgePost(body, ctx, deps);
  if (!judge.ok) return judge;
  let verdict = judge.value;

  for (let round = 0; round < config.judge.maxRounds && verdict.verdict === 'fail'; round += 1) {
    const fixed = await revise(body, formatJudge(verdict), ctx, deps);
    if (!fixed.ok) {
      // Модель сорвалась на круге правок: отдаём последнюю оценку владельцу,
      // а не теряем пост.
      return { ok: true, value: { body, lint, judge: verdict, rounds, verdict: 'fail', failedBy: 'judge' } };
    }
    rounds += 1;
    body = fixed.value;
    lint = runLint(body, ctx, config);
    judge = await judgePost(body, ctx, deps);
    if (!judge.ok) {
      return { ok: true, value: { body, lint, judge: verdict, rounds, verdict: 'fail', failedBy: 'judge' } };
    }
    verdict = judge.value;
  }

  const passed = verdict.verdict === 'pass' && lintPassed(lint);
  return {
    ok: true,
    value: {
      body,
      lint,
      judge: verdict,
      rounds,
      verdict: passed ? 'pass' : 'fail',
      ...(passed ? {} : { failedBy: verdict.verdict === 'fail' ? ('judge' as const) : ('lint' as const) }),
    },
  };
}

export { runLint };
