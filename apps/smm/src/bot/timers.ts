import type { Logger } from '../logger.ts';

/**
 * Таймеры окна отмены.
 *
 * Fail-closed по построению: таймер живёт в ПАМЯТИ процесса, и пост уходит в
 * канал только по живому таймеру, который видел клик. Перезапуск внутри окна
 * отмены поэтому публикацию не доводит — владелец нажимает заново. Обратный
 * порядок (восстанавливать таймеры из базы при старте) означал бы, что упавший
 * и поднявшийся процесс публикует то, что владелец уже мог передумать.
 */
export interface PublishTimers {
  schedule(postId: string, at: string, fire: (postId: string) => void): void;
  cancel(postId: string): void;
  /** Сколько таймеров сейчас живо: нужно проверке здоровья и тестам. */
  size(): number;
  stopAll(): void;
}

export interface TimersDeps {
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Подмена таймера в тестах: настоящий setTimeout ждал бы минуту. */
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  readonly clearTimer?: (handle: NodeJS.Timeout | number) => void;
}

export function createPublishTimers(deps: TimersDeps): PublishTimers {
  const now = deps.now ?? ((): Date => new Date());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const timers = new Map<string, NodeJS.Timeout | number>();

  return {
    schedule(postId, at, fire) {
      const delay = Math.max(0, Date.parse(at) - now().getTime());
      const existing = timers.get(postId);
      if (existing !== undefined) clearTimer(existing);
      const handle = setTimer(() => {
        timers.delete(postId);
        fire(postId);
      }, delay);
      timers.set(postId, handle);
      deps.logger.info({ postId, at, delay }, 'окно отмены пошло');
    },
    cancel(postId) {
      const handle = timers.get(postId);
      if (handle === undefined) return;
      clearTimer(handle);
      timers.delete(postId);
      deps.logger.info({ postId }, 'окно отмены снято');
    },
    size() {
      return timers.size;
    },
    stopAll() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
    },
  };
}
