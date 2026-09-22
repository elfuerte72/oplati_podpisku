import { layoutFor, smmConfig, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import type { DialogEvent, PipelineStep } from '../dialog/types.ts';
import { formatJudge, type JudgeVerdict } from '../llm/judge.ts';
import { formatLint } from '../lint/report.ts';
import type { Logger } from '../logger.ts';
import { buildDossier, plan, producePost, revisePost, type PipelineDeps } from '../pipeline/index.ts';
import type { HistoryPost, ReviewContext } from '../pipeline/types.ts';
import { renderPost, type RenderablePost } from '../render/render.ts';
import { sendPost, type SendApi, type SendTarget } from '../render/send.ts';
import { resolveSource, type ResolveOptions } from '../sources/resolve.ts';
import type { Article } from '../sources/article.ts';
import type { Store } from '../store/index.ts';
import type { Post } from '../store/types.ts';
import type { Dossier } from '../llm/schemas.ts';

/**
 * Шаги конвейера в мире бота: тут сходятся источники, конвейер, хранилище и
 * отправка. Исход каждого шага возвращается СОБЫТИЕМ — следующий переход
 * выбирает автомат, а не шаг.
 */

export interface RunnerDeps {
  readonly store: Store;
  readonly pipeline: PipelineDeps;
  readonly api: SendApi;
  readonly logger: Logger;
  readonly ownerId: number;
  readonly ownerChatId: number | string;
  readonly channelId: string;
  readonly config?: SmmConfig;
  readonly resolve?: ResolveOptions;
  readonly now?: () => Date;
}

export interface Runner {
  runStep(step: PipelineStep, args: Record<string, unknown>): Promise<DialogEvent | undefined>;
  /** Показать пост владельцу ровно так, как он уйдёт в канал. */
  preview(postId: string): Promise<void>;
  /** Опубликовать: ПОСЛЕ проверки права по журналу решений. */
  publish(postId: string): Promise<{ ok: boolean; message?: string }>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function historyOf(store: Store, platform: 'telegram' | 'threads'): HistoryPost[] {
  return store.posts.recentPublished({ platform, limit: 10 }).map((post) => ({
    id: post.id,
    cta: post.cta,
    body: post.body ?? '',
    ...(post.rubric === undefined ? {} : { rubric: post.rubric }),
  }));
}

function renderableOf(post: Post): RenderablePost {
  return {
    layout: post.layout ?? layoutFor(post.rubric ?? 'news').key,
    body: post.body ?? '',
    ...(post.sourceUrl === undefined ? {} : { sourceUrl: post.sourceUrl }),
    ...(post.imagePath === undefined ? {} : { imagePath: post.imagePath }),
    ...(post.buttonText === undefined ? {} : { buttonText: post.buttonText }),
    ...(post.buttonUrl === undefined ? {} : { buttonUrl: post.buttonUrl }),
  };
}

function reviewContextOf(post: Post, store: Store, dossier?: Dossier): ReviewContext {
  const rubric = (post.rubric ?? 'news') as RubricKey;
  return {
    platform: post.platform,
    rubric,
    layout: post.layout ?? layoutFor(rubric).key,
    cta: post.cta,
    hasImage: post.imagePath !== undefined,
    postId: post.id,
    ...(dossier === undefined ? {} : { dossier }),
    ...(post.angle === undefined ? {} : { angle: post.angle }),
    ...(post.tag === undefined ? {} : { tag: post.tag }),
    previous: historyOf(store, post.platform).filter((row) => row.id !== post.id),
    ...(post.platform === 'threads' ? { channelPrevious: historyOf(store, 'telegram') } : {}),
  };
}

function failed(step: PipelineStep, reason: string, message: string, at: string, postId?: string): DialogEvent {
  return { kind: 'pipeline_failed', step, reason, message, at, ...(postId === undefined ? {} : { postId }) };
}

export function createRunner(deps: RunnerDeps): Runner {
  const config = deps.config ?? smmConfig;
  const now = deps.now ?? ((): Date => new Date());
  const at = (): string => now().toISOString();

  /** Досье поста: оно уже лежит в строке, разбирать статью заново незачем. */
  function dossierOf(post: Post): Dossier | undefined {
    return post.dossier === undefined ? undefined : (post.dossier as Dossier);
  }

  async function stepSource(args: Record<string, unknown>): Promise<DialogEvent | undefined> {
    const input = asString(args.input);
    if (input === undefined) return failed('source', 'empty_input', 'пустой ввод', at());
    const platform = args.platform === 'threads' ? 'threads' : 'telegram';

    const resolved = await resolveSource(input, deps.resolve ?? {});
    if (resolved.kind === 'refused') {
      return failed('source', resolved.reason, resolved.message, at());
    }
    if (resolved.kind === 'failed') {
      return failed('source', resolved.reason, resolved.message, at());
    }
    if (resolved.kind === 'topic') {
      return {
        kind: 'pipeline_done',
        at: at(),
        outcome: {
          kind: 'candidates',
          candidates: resolved.candidates.map((candidate) => ({
            url: candidate.url,
            title: candidate.title,
          })),
        },
      };
    }

    const article: Article = resolved.article;
    const existingId = asString(args.postId);
    const post =
      existingId === undefined
        ? deps.store.posts.create({
            platform,
            brief: input,
            sourceUrl: article.url,
            sourceTitle: article.title,
          })
        : deps.store.posts.patch(existingId, {
            sourceUrl: article.url,
            sourceTitle: article.title,
          });
    if (post === undefined) return failed('source', 'no_post', 'пост не нашёлся', at(), existingId);

    // Текст статьи кладётся в досье-заготовку: следующий шаг разбирает его
    // моделью, и качать страницу заново не придётся.
    deps.store.posts.patch(post.id, { dossier: { article } });
    return {
      kind: 'pipeline_done',
      at: at(),
      outcome: { kind: 'article', postId: post.id, title: article.title },
    };
  }

  async function stepPlan(args: Record<string, unknown>, seen: readonly string[] = []): Promise<DialogEvent> {
    const postId = asString(args.postId);
    if (postId === undefined) return failed('plan', 'no_post', 'пост не назван', at());
    const post = deps.store.posts.get(postId);
    if (post === undefined) return failed('plan', 'no_post', 'пост не нашёлся', at(), postId);

    const stored = post.dossier as { article?: Article } | Dossier | undefined;
    let dossier = dossierOf(post);

    if (stored !== undefined && 'article' in (stored as object)) {
      const article = (stored as { article: Article }).article;
      const built = await buildDossier(
        { url: article.url, title: article.title, text: article.text },
        deps.pipeline,
        { postId },
      );
      if (!built.ok) return failed('plan', built.reason, built.message, at(), postId);
      dossier = built.value;
      deps.store.posts.patch(postId, { dossier });
    }
    if (dossier === undefined) return failed('plan', 'no_dossier', 'досье не собрано', at(), postId);

    const planned = await plan(
      { dossier, postId, seenAngles: seen, ...(seen.length > 0 ? {} : {}) },
      deps.pipeline,
    );
    if (!planned.ok) return failed('plan', planned.reason, planned.message, at(), postId);

    return {
      kind: 'pipeline_done',
      at: at(),
      outcome: {
        kind: 'plan',
        postId,
        rubric: planned.value.rubric,
        angles: planned.value.angles.map((angle) => ({ title: angle.title, idea: angle.idea })),
      },
    };
  }

  /** Перевод поста в «проверен» и запись результатов проверки одной точкой. */
  function storeReviewed(
    post: Post,
    body: string,
    lintReport: unknown,
    judge: JudgeVerdict | undefined,
    rounds: number,
    ownerText: boolean,
  ): void {
    deps.store.posts.patch(post.id, {
      body,
      rounds,
      ownerText,
      lint: lintReport,
      ...(judge === undefined ? {} : { judge }),
    });
    const fresh = deps.store.posts.get(post.id);
    if (fresh === undefined) return;
    if (fresh.status === 'draft') {
      deps.store.posts.transition({
        id: post.id,
        from: ['draft'],
        to: 'linted',
        decision: { kind: 'lint', actor: 'code' },
      });
    }
    const afterLint = deps.store.posts.get(post.id);
    if (afterLint?.status === 'linted') {
      deps.store.posts.transition({
        id: post.id,
        from: ['linted'],
        to: 'reviewed',
        decision: { kind: 'judge', actor: 'model', payload: judge === undefined ? undefined : { mean: judge.mean } },
      });
    }
  }

  async function stepProduce(args: Record<string, unknown>): Promise<DialogEvent> {
    const postId = asString(args.postId);
    if (postId === undefined) return failed('produce', 'no_post', 'пост не назван', at());
    const post = deps.store.posts.get(postId);
    if (post === undefined) return failed('produce', 'no_post', 'пост не нашёлся', at(), postId);
    const dossier = dossierOf(post);
    if (dossier === undefined || !('facts' in (dossier as object))) {
      return failed('produce', 'no_dossier', 'досье не собрано', at(), postId);
    }
    const rubric = (asString(args.rubric) ?? post.rubric ?? 'news') as RubricKey;
    const angle = asString(args.angle) ?? post.angle ?? '';
    const layout = layoutFor(rubric).key;
    deps.store.posts.patch(postId, { rubric, angle, layout });

    const produced = await producePost(
      {
        platform: post.platform,
        dossier,
        rubric,
        angle,
        hasImage: post.imagePath !== undefined,
        postId,
        history: historyOf(deps.store, post.platform),
        ...(post.platform === 'threads' ? { channelPrevious: historyOf(deps.store, 'telegram') } : {}),
      },
      deps.pipeline,
    );
    if (!produced.ok) return failed('produce', produced.reason, produced.message, at(), postId);

    deps.store.posts.patch(postId, { cta: produced.value.cta });
    storeReviewed(post, produced.value.body, produced.value.lint, produced.value.judge, produced.value.rounds, false);

    const fresh = deps.store.posts.get(postId);
    const summary = [
      produced.value.judge === undefined ? '' : formatJudge(produced.value.judge),
      formatLint(produced.value.lint),
    ]
      .filter((part) => part !== '')
      .join('\n');

    return {
      kind: 'pipeline_done',
      at: at(),
      outcome: {
        kind: 'post',
        postId,
        textSha: fresh?.textSha ?? '',
        verdict: produced.value.verdict,
        ...(produced.value.verdict === 'fail' ? { summary } : {}),
      },
    };
  }

  async function stepRevise(args: Record<string, unknown>, ownerText: boolean): Promise<DialogEvent> {
    const postId = asString(args.postId);
    if (postId === undefined) return failed('revise', 'no_post', 'пост не назван', at());
    const post = deps.store.posts.get(postId);
    if (post === undefined) return failed('revise', 'no_post', 'пост не нашёлся', at(), postId);

    const change = ownerText
      ? ({ kind: 'owner_text', text: asString(args.text) ?? '' } as const)
      : ({ kind: 'instruction', text: asString(args.instruction) ?? '' } as const);
    if (change.text === '') return failed('revise', 'empty', 'пустая правка', at(), postId);

    const revised = await revisePost(
      { body: post.body ?? '', context: reviewContextOf(post, deps.store, dossierOf(post)) },
      change,
      deps.pipeline,
    );
    if (!revised.ok) return failed('revise', revised.reason, revised.message, at(), postId);

    storeReviewed(post, revised.value.body, revised.value.lint, revised.value.judge, revised.value.rounds, ownerText);
    const fresh = deps.store.posts.get(postId);
    const summary = [
      revised.value.judge === undefined ? '' : formatJudge(revised.value.judge),
      formatLint(revised.value.lint),
    ]
      .filter((part) => part !== '')
      .join('\n');

    return {
      kind: 'pipeline_done',
      at: at(),
      outcome: {
        kind: 'post',
        postId,
        textSha: fresh?.textSha ?? '',
        verdict: revised.value.verdict,
        ...(revised.value.verdict === 'fail' ? { summary } : {}),
      },
    };
  }

  async function send(post: Post, target: SendTarget): Promise<{ ok: boolean; messageId?: number; message?: string }> {
    const rendered = renderPost(renderableOf(post), config);
    if (!rendered.ok) {
      deps.logger.warn({ postId: post.id, reason: rendered.reason }, 'пост не отрисовался');
      return { ok: false, message: rendered.message };
    }
    const sent = await sendPost(deps.api, target, rendered.outgoing);
    if (!sent.ok) {
      deps.logger.warn({ postId: post.id, code: sent.code }, 'пост не отправился');
      return { ok: false, message: sent.message };
    }
    return { ok: true, messageId: sent.messageId };
  }

  return {
    async runStep(step, args) {
      switch (step) {
        case 'source':
          return stepSource(args);
        case 'plan':
          return stepPlan(args);
        case 'angles': {
          const seen = Array.isArray(args.seenAngles) ? (args.seenAngles as string[]) : [];
          return stepPlan(args, seen);
        }
        case 'produce':
          return stepProduce(args);
        case 'revise':
          return stepRevise(args, false);
        case 'owner_text':
          return stepRevise(args, true);
        case 'publish': {
          const postId = asString(args.postId);
          if (postId === undefined) return undefined;
          const result = await this.publish(postId);
          if (!result.ok) {
            return failed('publish', 'publish_refused', result.message ?? 'публикация не состоялась', at(), postId);
          }
          return undefined;
        }
        default:
          // Команды `/queue`, `/stats`, `/settings` обслуживает бот: у них нет
          // конвейера, и событие автомату они не возвращают.
          return undefined;
      }
    },

    async preview(postId) {
      const post = deps.store.posts.get(postId);
      if (post === undefined) return;
      const result = await send(post, { chatId: deps.ownerChatId });
      if (!result.ok) return;
      // Показ превью — это ФАКТ: от него отсчитывается право на публикацию.
      deps.store.posts.transition({
        id: postId,
        from: ['reviewed', 'previewed', 'approved'],
        to: 'previewed',
        decision: { kind: 'preview', actor: 'code' },
      });
    },

    async publish(postId) {
      const post = deps.store.posts.get(postId);
      if (post === undefined) return { ok: false, message: 'пост не нашёлся' };

      // ⚠️ Гейт публикации ЗДЕСЬ, даже если автомат прислал эффект: два слоя
      // защиты, потому что в канал пост уходит один раз и навсегда.
      if (!deps.store.posts.isApprovedForPublish(postId, deps.ownerId)) {
        deps.logger.warn({ postId, status: post.status }, 'публикация без подтверждения владельца отклонена');
        return { ok: false, message: 'нет подтверждения владельца под этим текстом' };
      }

      const result = await send(post, { chatId: deps.channelId });
      if (!result.ok) return { ok: false, message: result.message ?? 'не отправилось' };

      const moved = deps.store.posts.transition({
        id: postId,
        from: ['approved'],
        to: 'published',
        decision: { kind: 'publish', actor: 'code', payload: { messageId: result.messageId } },
        patch: {
          publishAt: null,
          ...(result.messageId === undefined ? {} : { channelMessageId: result.messageId }),
        },
      });
      if (!moved.ok) {
        // Пост уже ушёл в канал, а статус не сдвинулся: это ровно тот случай,
        // когда молчать нельзя — иначе тот же пост опубликуется второй раз.
        deps.logger.error({ postId, actual: moved.actual }, 'пост опубликован, но статус не перешёл');
      }
      return { ok: true };
    },
  };
}
