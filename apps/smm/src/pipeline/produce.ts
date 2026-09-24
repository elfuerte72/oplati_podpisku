import { layoutFor, smmConfig } from '../config/smm.config.ts';
import { advise } from './advise.ts';
import { review } from './review.ts';
import { writeDraft } from './steps.ts';
import type {
  Brief,
  PipelineDeps,
  ProducedPost,
  ReviewContext,
  ReviewedDraft,
  StepResult,
} from './types.ts';

/**
 * Счастливый путь после того, как владелец выбрал рубрику и угол:
 * советник → автор → проверка. Персистит вызывающий: конвейер ничего не знает
 * ни про хранилище, ни про Telegram.
 */

function reviewContextOf(brief: Brief, cta: ReviewContext['cta']): ReviewContext {
  return {
    platform: brief.platform,
    rubric: brief.rubric,
    layout: layoutFor(brief.rubric).key,
    cta,
    hasImage: brief.hasImage,
    dossier: brief.dossier,
    angle: brief.angle,
    ...(brief.tag === undefined ? {} : { tag: brief.tag }),
    ...(brief.postId === undefined ? {} : { postId: brief.postId }),
    ...(brief.history === undefined ? {} : { previous: brief.history }),
    ...(brief.channelPrevious === undefined ? {} : { channelPrevious: brief.channelPrevious }),
  };
}

export async function producePost(
  brief: Brief,
  deps: PipelineDeps,
): Promise<StepResult<ProducedPost>> {
  const config = deps.config ?? smmConfig;
  const layout = layoutFor(brief.rubric);
  const plan = advise({
    rubric: brief.rubric,
    config,
    ...(brief.history === undefined ? {} : { history: brief.history }),
    ...(brief.noAds === true ? { noAds: true } : {}),
  });

  const draft = await writeDraft(
    {
      dossier: brief.dossier,
      rubric: brief.rubric,
      angle: brief.angle,
      advice: plan,
      ...(brief.postId === undefined ? {} : { postId: brief.postId }),
    },
    deps,
  );
  if (!draft.ok) return draft;

  const checked = await review(draft.value, reviewContextOf(brief, plan.cta), deps);
  if (!checked.ok) return checked;

  return {
    ok: true,
    value: { ...checked.value, advice: plan, cta: plan.cta, layout: layout.key },
  };
}

export type PostChange =
  | { readonly kind: 'instruction'; readonly text: string }
  /** Текст владельца дословно: редактор его не смотрит, линт смотрит. */
  | { readonly kind: 'owner_text'; readonly text: string };

export interface RevisableePost {
  readonly body: string;
  readonly context: ReviewContext;
}

/**
 * Правки. Две разные вещи под одной кнопкой:
 *   - «скажу, что поменять» — реплика владельца идёт в круг правок, потом линт
 *     и редактор как обычно;
 *   - «пришлю свой текст» — текст владельца уходит ДОСЛОВНО: редактор его не
 *     оценивает, и бот не «улучшает» человека.
 */
export async function revisePost(
  post: RevisableePost,
  change: PostChange,
  deps: PipelineDeps,
): Promise<StepResult<ReviewedDraft>> {
  if (change.kind === 'owner_text') {
    return review(change.text, { ...post.context, ownerText: true }, deps);
  }

  const config = deps.config ?? smmConfig;
  const logCtx = {
    step: 'revise_by_owner',
    ...(post.context.postId === undefined ? {} : { postId: post.context.postId }),
  };
  deps.logger.info({ ...logCtx, status: 'started' }, 'шаг конвейера');
  const answer = await deps.model.markdown(
    'revise',
    [
      `Раскладка ${config.layouts[post.context.layout].letter}: от ` +
        `${config.layouts[post.context.layout].minChars} до ` +
        `${config.layouts[post.context.layout].maxChars} видимых знаков.`,
      '',
      'Что просит поменять владелец (и только это):',
      change.text,
      '',
      'Текст поста:',
      '<<<',
      post.body,
      '>>>',
      ...(post.context.dossier === undefined
        ? []
        : ['', 'Досье (новых утверждений вне него быть не должно):', JSON.stringify(post.context.dossier)]),
    ].join('\n'),
    { ...(post.context.postId === undefined ? {} : { postId: post.context.postId }) },
  );
  if (!answer.ok) {
    deps.logger.warn({ ...logCtx, status: 'failed', reason: answer.reason }, 'шаг конвейера');
    return { ok: false, reason: 'model_failed', message: `${answer.reason}: ${answer.message}` };
  }
  deps.logger.info({ ...logCtx, status: 'done' }, 'шаг конвейера');
  return review(answer.value, post.context, deps);
}
