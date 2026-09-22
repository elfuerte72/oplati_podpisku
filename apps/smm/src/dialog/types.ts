import type { RubricKey } from '../config/smm.config.ts';

/**
 * Диалог владельца — конечный автомат, а не модель.
 *
 * Причина в спеке названа прямо: прежний контур решал словами, и «дословно»
 * превращалось в «поправил тире», а «публикуй» — в догадку по журналу сессий.
 * Здесь переходы описаны таблицей, эффекты возвращаются ДАННЫМИ, а исполнитель
 * живёт отдельно и тестируется отдельно.
 */

export const STATES = [
  'idle',
  'post.await_input',
  'post.await_source_pick',
  'post.await_rubric',
  'post.await_angle',
  'post.generating',
  'post.previewed',
  'post.await_edit_choice',
  'post.await_edit_text',
  'post.await_owner_text',
  'post.publish_pending',
  'post.failed',
  /**
   * Превью Threads. Отдельное состояние, а не флаг у `post.previewed`: там
   * кнопка публикует в канал, здесь — фиксирует, что владелец выложил пост
   * руками. Один и тот же экран с двумя смыслами — способ однажды нажать не то.
   */
  'threads.previewed',
] as const;

export type StateName = (typeof STATES)[number];

/** Состояния, в которых бот ЖДЁТ текст владельца. В остальных текст получает меню. */
export const TEXT_STATES: readonly StateName[] = [
  'post.await_input',
  'post.await_source_pick',
  'post.await_edit_text',
  'post.await_owner_text',
];

export interface SourceCandidate {
  readonly url: string;
  readonly title: string;
}

export interface AngleOption {
  readonly title: string;
  readonly idea: string;
}

export interface FlowPayload {
  /**
   * Отпечаток вопроса или текста на момент показа кнопок. Нажатие с чужим
   * отпечатком — это клик по старому сообщению: такие кнопки не работают.
   */
  readonly stamp?: string;
  readonly candidates?: readonly SourceCandidate[];
  readonly angles?: readonly AngleOption[];
  readonly rubric?: RubricKey;
  readonly angle?: string;
  /** Сколько раз показывали углы: «Другие углы» даётся один раз. */
  readonly anglesShown?: number;
  /** Углы, которые владелец уже видел: повторять их в новом плане незачем. */
  readonly seenAngles?: readonly string[];
  readonly previewMessageId?: number;
  readonly publishAt?: string;
  /** Короткая сводка оценки редактора для сообщения владельцу. */
  readonly judgeSummary?: string;
}

export interface FlowState {
  readonly name: StateName;
  readonly postId?: string;
  readonly payload?: FlowPayload;
  /** Когда вопрос перестаёт ждать ответа. Истёкшее ожидание — idle. */
  readonly expiresAt?: string;
}

export type PipelineStep =
  | 'source'
  | 'plan'
  | 'angles'
  | 'produce'
  | 'revise'
  | 'owner_text'
  | 'publish'
  | 'queue'
  | 'stats'
  | 'settings'
  | 'threads';

/** Что принёс шаг конвейера: автомат знает ИСХОД, а не устройство шага. */
export type PipelineOutcome =
  | { readonly kind: 'article'; readonly postId: string; readonly title: string }
  | { readonly kind: 'candidates'; readonly candidates: readonly SourceCandidate[] }
  | {
      readonly kind: 'plan';
      readonly postId: string;
      readonly rubric: RubricKey;
      readonly angles: readonly AngleOption[];
    }
  | {
      readonly kind: 'post';
      readonly postId: string;
      readonly textSha: string;
      readonly verdict: 'pass' | 'fail';
      /** Площадка: у Threads своё превью и своя кнопка. */
      readonly platform?: 'telegram' | 'threads';
      readonly summary?: string;
    }
  | {
      /** Пост ушёл в канал: отсюда предлагается версия для Threads. */
      readonly kind: 'published';
      readonly postId: string;
      readonly textSha: string;
    };

export type DialogEvent =
  | { readonly kind: 'command'; readonly command: string; readonly args: string; readonly at: string }
  | { readonly kind: 'text'; readonly text: string; readonly at: string }
  | {
      readonly kind: 'callback';
      readonly data: string;
      readonly at: string;
      readonly messageId?: number;
    }
  | { readonly kind: 'pipeline_done'; readonly outcome: PipelineOutcome; readonly at: string }
  | {
      readonly kind: 'pipeline_failed';
      readonly step: PipelineStep;
      readonly reason: string;
      readonly message: string;
      readonly postId?: string;
      readonly at: string;
    }
  | { readonly kind: 'timer_fired'; readonly postId: string; readonly at: string }
  | { readonly kind: 'expired'; readonly at: string };

export interface KeyboardButton {
  readonly text: string;
  /** Кнопка-действие: данные уходят колбэком. */
  readonly data?: string;
  /** Кнопка-ссылка: открывает адрес (Web Intent Threads). */
  readonly url?: string;
  /** Кнопка копирования: запасной путь, когда адрес не влез в лимит. */
  readonly copyText?: string;
}

export interface Keyboard {
  readonly rows: readonly (readonly KeyboardButton[])[];
}

export type Effect =
  | { readonly type: 'send'; readonly text: string; readonly keyboard?: Keyboard }
  /** Снять или заменить клавиатуру под старым сообщением. */
  | { readonly type: 'edit_keyboard'; readonly messageId: number; readonly keyboard: Keyboard | null }
  | { readonly type: 'answer_callback'; readonly text?: string }
  | { readonly type: 'run'; readonly step: PipelineStep; readonly args?: Record<string, unknown> }
  /** Показать пост ровно так, как он уйдёт в канал. */
  | { readonly type: 'preview'; readonly postId: string }
  | { readonly type: 'schedule_publish'; readonly postId: string; readonly at: string }
  | { readonly type: 'cancel_publish'; readonly postId: string }
  | { readonly type: 'persist'; readonly postId: string; readonly patch: Record<string, unknown> }
  | {
      readonly type: 'decision';
      readonly postId: string;
      readonly kind: string;
      readonly textSha?: string;
      readonly payload?: unknown;
    };

export interface TransitionContext {
  readonly now: string;
  /** Сколько живёт вопрос бота. */
  readonly questionTtlMs: number;
  /** Окно отмены публикации. */
  readonly undoSeconds: number;
}

export interface Transition {
  readonly state: FlowState;
  readonly effects: readonly Effect[];
}
