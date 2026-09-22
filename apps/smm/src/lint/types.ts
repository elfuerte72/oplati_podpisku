import type { CtaLevel, LayoutKey, SmmConfig } from '../config/smm.config.ts';

/**
 * Находка линта. `code` — стабильный ключ для тестов и статистики, `message` —
 * текст для модели в круге правок и для владельца. Две вещи в одной находке,
 * потому что читатели у неё разные, а правило одно.
 */
export interface Finding {
  readonly code: string;
  readonly message: string;
}

export interface LintResult {
  readonly errors: readonly Finding[];
  readonly warnings: readonly Finding[];
}

/** Пост, с которым сравнивают свежесть: только то, что нужно правилу. */
export interface PreviousPost {
  readonly id: string;
  readonly body: string;
}

export interface LintContext {
  readonly layout: LayoutKey;
  readonly cta: CtaLevel;
  readonly hasImage: boolean;
  /**
   * Последние посты площадки, свежие первыми. Передаются АРГУМЕНТОМ: линт
   * обязан быть детерминированным и не ходить в базу.
   */
  readonly previous?: readonly PreviousPost[];
  readonly config?: SmmConfig;
}

export interface ThreadsLintContext {
  readonly cta: CtaLevel;
  readonly tag?: string;
  /** Последние посты Threads — для свежести внутри площадки. */
  readonly previous?: readonly PreviousPost[];
  /** Последние посты КАНАЛА — чтобы поймать копипасту между площадками. */
  readonly channelPrevious?: readonly PreviousPost[];
  readonly config?: SmmConfig;
}
