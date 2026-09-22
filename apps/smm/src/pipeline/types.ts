import type { CtaLevel, LayoutKey, RubricKey, SmmConfig } from '../config/smm.config.ts';
import type { JudgeVerdict } from '../llm/judge.ts';
import type { Dossier, Plan } from '../llm/schemas.ts';
import type { Model } from '../llm/model.ts';
import type { LintResult } from '../lint/types.ts';
import type { Logger } from '../logger.ts';

export type Platform = 'telegram' | 'threads';

/**
 * Пост из истории — ровно то, что нужно советнику и линту свежести. Конвейер
 * НЕ знает про хранилище: историю ему передаёт вызывающий.
 */
export interface HistoryPost {
  readonly id: string;
  readonly rubric?: RubricKey;
  readonly cta: CtaLevel;
  readonly body: string;
}

export interface Advice {
  readonly cta: CtaLevel;
  /** Почему именно такой уровень рекламы: строки уходят в промпт автора. */
  readonly ctaReasons: readonly string[];
  /** Рубрики, которых вышло меньше плана, самые обделённые первыми. */
  readonly rubricDeficit: readonly string[];
  /** Что занято последними постами: зачины, связки, концовки, форма. */
  readonly doNotRepeat: readonly string[];
  /** Готовый фрагмент для промпта автора. Это ПРАВИЛО, а не подсказка. */
  readonly text: string;
}

export interface PipelineDeps {
  readonly model: Model;
  readonly logger: Logger;
  readonly config?: SmmConfig;
}

export type StepFailure =
  | 'model_failed'
  | 'lint_failed'
  | 'judge_failed'
  | 'nothing_changes'
  | 'empty_source';

export type StepResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: StepFailure; readonly message: string };

export interface ReviewContext {
  readonly platform: Platform;
  readonly rubric: RubricKey;
  readonly layout: LayoutKey;
  readonly cta: CtaLevel;
  readonly hasImage: boolean;
  readonly dossier?: Dossier;
  readonly angle?: string;
  readonly tag?: string;
  readonly previous?: readonly HistoryPost[];
  /** Посты канала: их видит линт Threads, чтобы поймать копипасту. */
  readonly channelPrevious?: readonly HistoryPost[];
  readonly postId?: string;
  /** Текст владельца дословно: редактор его не смотрит. */
  readonly ownerText?: boolean;
}

export interface ReviewedDraft {
  readonly body: string;
  readonly lint: LintResult;
  readonly judge?: JudgeVerdict;
  /** Сколько кругов правок понадобилось. */
  readonly rounds: number;
  readonly verdict: 'pass' | 'fail';
  /** Почему `fail`: линт или редактор. */
  readonly failedBy?: 'lint' | 'judge';
}

export interface Brief {
  readonly platform: Platform;
  readonly dossier: Dossier;
  readonly rubric: RubricKey;
  readonly angle: string;
  readonly hasImage: boolean;
  readonly sourceUrl?: string;
  readonly tag?: string;
  readonly postId?: string;
  readonly history?: readonly HistoryPost[];
  readonly channelPrevious?: readonly HistoryPost[];
}

export interface ProducedPost extends ReviewedDraft {
  readonly advice: Advice;
  readonly cta: CtaLevel;
  readonly layout: LayoutKey;
}

export type { Dossier, Plan };
