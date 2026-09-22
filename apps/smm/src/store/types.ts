import type { CtaLevel, LayoutKey, RubricKey } from '../config/smm.config.ts';
import type { DecisionActor, DecisionKind, PostStatus } from './post-state.ts';

export type Platform = 'telegram' | 'threads';

/** Пост канала или Threads — единица работы владельца. */
export interface Post {
  readonly id: string;
  readonly platform: Platform;
  readonly status: PostStatus;
  readonly rubric?: RubricKey;
  readonly layout?: LayoutKey;
  readonly angle?: string;
  readonly cta: CtaLevel;
  readonly brief?: string;
  readonly sourceUrl?: string;
  readonly sourceTitle?: string;
  readonly dossier?: unknown;
  readonly body?: string;
  readonly textSha?: string;
  readonly imagePath?: string;
  /** Текст владельца дословно: редактор его не смотрит, линт смотрит. */
  readonly ownerText: boolean;
  readonly judge?: unknown;
  readonly lint?: unknown;
  readonly rounds: number;
  readonly tag?: string;
  readonly buttonText?: string;
  readonly buttonUrl?: string;
  readonly channelMessageId?: number;
  readonly itemId?: string;
  readonly parentPostId?: string;
  readonly publishAt?: string;
  readonly previewedAt?: string;
  readonly publishedAt?: string;
  readonly withdrawnAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPost {
  readonly platform: Platform;
  readonly brief?: string;
  readonly sourceUrl?: string;
  readonly sourceTitle?: string;
  readonly rubric?: RubricKey;
  readonly layout?: LayoutKey;
  readonly cta?: CtaLevel;
  readonly itemId?: string;
  readonly parentPostId?: string;
  readonly dossier?: unknown;
}

/**
 * Что можно менять у поста, не двигая статус. `status` сюда не входит
 * НАМЕРЕННО: единственный способ сменить статус — `transition`, и это
 * проверяется канарейкой по коду.
 */
export interface PostPatch {
  readonly rubric?: RubricKey;
  readonly layout?: LayoutKey;
  readonly angle?: string;
  readonly cta?: CtaLevel;
  readonly brief?: string;
  readonly sourceUrl?: string;
  readonly sourceTitle?: string;
  readonly dossier?: unknown;
  readonly body?: string;
  readonly textSha?: string;
  readonly imagePath?: string;
  readonly ownerText?: boolean;
  readonly judge?: unknown;
  readonly lint?: unknown;
  readonly rounds?: number;
  readonly tag?: string;
  readonly buttonText?: string;
  readonly buttonUrl?: string;
  readonly channelMessageId?: number;
  readonly itemId?: string;
  readonly publishAt?: string | null;
}

export interface DecisionInput {
  readonly kind: DecisionKind;
  readonly actor: DecisionActor;
  readonly textSha?: string;
  readonly payload?: unknown;
}

export interface Decision extends DecisionInput {
  readonly id: number;
  readonly postId?: string;
  readonly createdAt: string;
}

export interface TransitionInput {
  readonly id: string;
  /** Из каких статусов переход разрешён. Ноль затронутых строк — переход не состоялся. */
  readonly from: readonly PostStatus[];
  readonly to: PostStatus;
  readonly decision: DecisionInput;
  readonly patch?: PostPatch;
}

export type TransitionResult =
  | { readonly ok: true; readonly post: Post }
  /** `actual` — ФАКТИЧЕСКИЙ статус (или `null`, если поста уже нет). Врать о состоянии нельзя. */
  | { readonly ok: false; readonly actual: PostStatus | null };

export interface FlowRow {
  readonly state: string;
  readonly postId?: string;
  readonly payload?: unknown;
  readonly expiresAt?: string;
  readonly updatedAt: string;
}

export interface Item {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceRef?: string;
  readonly url: string;
  readonly title?: string;
  readonly publishedAt?: string;
  readonly seenAt: string;
  readonly rank?: unknown;
  readonly verdict?: 'written' | 'skipped' | 'offtopic';
}

export interface NewItem {
  readonly sourceKind: string;
  readonly sourceRef?: string;
  readonly url: string;
  readonly title?: string;
  readonly publishedAt?: string;
}

export interface UsageInput {
  readonly postId?: string;
  readonly role: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  /** Деньги — целыми микродолларами: вызов стоит доли цента, float набирает ошибку. */
  readonly usdMicros: number;
  readonly isPeak: boolean;
  readonly priceKnown: boolean;
}

export interface UsageByRole {
  readonly role: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  readonly usdMicros: number;
}

export interface UsageSummary {
  readonly usdMicros: number;
  readonly calls: number;
  readonly byRole: readonly UsageByRole[];
  /** true — в сумме есть вызовы модели с неизвестным тарифом, число оценочное. */
  readonly hasUnknownPrice: boolean;
}
