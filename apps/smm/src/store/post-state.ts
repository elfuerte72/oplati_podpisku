/**
 * Машина статусов поста. Прямой `UPDATE posts SET status` запрещён — переход
 * идёт только через `transitionPost` (канарейка `store.canary.test.ts`), а
 * разрешённые переходы описаны здесь, как `allowedTransitions` в проде.
 */

export const POST_STATUSES = [
  'draft',
  'linted',
  'reviewed',
  'previewed',
  'approved',
  'published',
  'handed',
  'posted',
  'rejected',
  'withdrawn',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * Куда можно уйти из каждого статуса.
 *
 * Почему именно так:
 * - `published` ведёт ТОЛЬКО в `withdrawn`: вышедший пост нельзя «вернуть в
 *   черновики», его можно только удалить из канала;
 * - прыжка в `published` из чего-либо, кроме `approved`, нет: публикуется
 *   только то, что владелец увидел в превью и подтвердил кнопкой;
 * - `approved → previewed` — это «Отменить» в окне ожидания;
 * - возврат в `draft` разрешён с любого шага до публикации: это круг правок и
 *   «Другой угол»;
 * - `previewed → previewed` и `handed → handed` — повторный показ того же
 *   поста из `/queue`: передача Threads это несколько сообщений подряд, и
 *   оборванная на середине повторяется целиком;
 * - `handed` и `posted` — путь Threads: публикует человек, бот только отдаёт
 *   ему готовый текст и фиксирует факт.
 */
export const allowedTransitions: Record<PostStatus, readonly PostStatus[]> = {
  draft: ['linted', 'rejected'],
  linted: ['reviewed', 'draft', 'rejected'],
  reviewed: ['previewed', 'handed', 'draft', 'rejected'],
  previewed: ['approved', 'previewed', 'handed', 'draft', 'rejected'],
  approved: ['published', 'previewed', 'rejected'],
  published: ['withdrawn'],
  handed: ['posted', 'handed', 'draft', 'rejected'],
  posted: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};

/** Пост уже ничего не ждёт: ни владельца, ни кода. */
export function isTerminal(status: PostStatus): boolean {
  return allowedTransitions[status].length === 0;
}

/** Что показывает `/queue`: начатое и ещё не вышедшее. */
export const IN_PROGRESS_STATUSES: readonly PostStatus[] = [
  'draft',
  'linted',
  'reviewed',
  'previewed',
  'approved',
  'handed',
];

export function isTransitionAllowed(from: PostStatus, to: PostStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/** Решения владельца и кода, которые пишутся в журнал `decisions`. */
export const DECISION_KINDS = [
  'approve',
  'cancel',
  'reject',
  'edit',
  'owner_text',
  'angle',
  'rubric',
  'threads_posted',
  'withdraw',
  'publish',
  'preview',
  'lint',
  'judge',
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export type DecisionActor = 'owner' | 'code' | 'model';
