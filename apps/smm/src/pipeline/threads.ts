import { smmConfig } from '../config/smm.config.ts';
import { ThreadsPostSchema, type ThreadsPost } from '../llm/schemas.ts';
import { threadsInput } from './inputs.ts';
import { review } from './review.ts';
import { logStepDone, logStepFailed, logStepStarted } from './steps.ts';
import type {
  Brief,
  PipelineDeps,
  ProducedPost,
  ReviewContext,
  StepResult,
} from './types.ts';

/**
 * Ветка Threads: пост пишется по ТОМУ ЖЕ досье, что и пост канала, но не
 * копией текста — площадка официально режет охват неоригинальному, а читатель,
 * который видит обе ленты, узнаёт дубль.
 */

/** Части и ссылка в одном тексте: так его видят линт, редактор и владелец. */
export function threadsBody(post: ThreadsPost): string {
  const separator = `\n${smmConfig.threads.separator}\n`;
  const pieces = [...post.pieces];
  if (post.link !== undefined && post.link !== '') {
    // Ссылка живёт в ПОСЛЕДНЕЙ части: пост со ссылкой в первой собирает меньше
    // реакций, а реакции и есть охват.
    const last = pieces.pop() ?? '';
    pieces.push(`${last}\n${post.link}`.trim());
  }
  return pieces.join(separator);
}

export async function threadsAdapt(
  input: { dossier: Brief['dossier']; angle: string; link?: string; postId?: string },
  deps: PipelineDeps,
): Promise<StepResult<ThreadsPost>> {
  const ctx = {
    step: 'threads',
    ...(input.postId === undefined ? {} : { postId: input.postId }),
  };
  logStepStarted(deps, ctx);
  const at = Date.now();
  const answer = await deps.model.json(
    'threads',
    threadsInput({
      dossier: input.dossier,
      angle: input.angle,
      ...(input.link === undefined ? {} : { link: input.link }),
      ...(deps.config === undefined ? {} : { config: deps.config }),
    }),
    ThreadsPostSchema,
    { ...(input.postId === undefined ? {} : { postId: input.postId }) },
  );
  if (!answer.ok) {
    logStepFailed(deps, ctx, answer.reason, Date.now() - at);
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  logStepDone(deps, ctx, Date.now() - at);
  return { ok: true, value: answer.value };
}

export interface ThreadsDraft extends ProducedPost {
  readonly tag?: string;
  readonly hook: string;
}

/**
 * Полный путь поста для Threads: адаптация досье, линт площадки, редактор с
 * её критериями и те же круги правок, что у канала.
 */
export async function produceThreadsPost(
  brief: Brief,
  deps: PipelineDeps,
): Promise<StepResult<ThreadsDraft>> {
  const adapted = await threadsAdapt(
    {
      dossier: brief.dossier,
      angle: brief.angle,
      ...(brief.sourceUrl === undefined ? {} : { link: brief.sourceUrl }),
      ...(brief.postId === undefined ? {} : { postId: brief.postId }),
    },
    deps,
  );
  if (!adapted.ok) return adapted;

  const body = threadsBody(adapted.value);
  const ctx: ReviewContext = {
    platform: 'threads',
    rubric: brief.rubric,
    // Раскладки у Threads нет: поле нужно круги правок и сообщениям об ошибке.
    layout: 'a',
    cta: 'none',
    hasImage: brief.hasImage,
    dossier: brief.dossier,
    angle: brief.angle,
    ...(adapted.value.tag === undefined ? {} : { tag: adapted.value.tag }),
    ...(brief.postId === undefined ? {} : { postId: brief.postId }),
    ...(brief.history === undefined ? {} : { previous: brief.history }),
    ...(brief.channelPrevious === undefined ? {} : { channelPrevious: brief.channelPrevious }),
  };

  const checked = await review(body, ctx, deps);
  if (!checked.ok) return checked;

  return {
    ok: true,
    value: {
      ...checked.value,
      advice: {
        cta: 'none',
        ctaReasons: ['у Threads свой жанр: рекламы в тексте нет'],
        rubricDeficit: [],
        doNotRepeat: [],
        text: '',
      },
      cta: 'none',
      layout: 'a',
      hook: adapted.value.hook,
      ...(adapted.value.tag === undefined ? {} : { tag: adapted.value.tag }),
    },
  };
}
