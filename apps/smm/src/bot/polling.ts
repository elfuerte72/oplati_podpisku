import type { Logger } from '../logger.ts';

/**
 * Запуск long polling с повтором.
 *
 * ⚠️ При выкате Swarm какое-то время держит СТАРЫЙ контейнер рядом с новым, и
 * Telegram отдаёт `getUpdates` кому-то одному: проигравший получает
 * `409 Conflict: terminated by other getUpdates request`. Раньше цикл на этом
 * просто останавливался — сервис оставался `1/1`, проверка здоровья зелёной, а
 * бот НЕ ПРИНИМАЛ команды вовсе. Поймано первым же выкатом 22.09.2026.
 *
 * Поэтому 409 — не конец, а «подожди, пока предыдущий отпустит»: повторяем с
 * нарастающей паузой, и только исчерпав попытки, признаём, что бот глух, —
 * громко, через переданный колбэк.
 */

export interface PollingDeps {
  /** Запустить цикл. Возвращается только когда цикл остановлен или упал. */
  readonly start: () => Promise<void>;
  readonly logger: Logger;
  /** Паузы между попытками, мс. Длина массива = число повторов. */
  readonly delays?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  /** Попытки кончились: бот не принимает команды и молчать об этом нельзя. */
  readonly onGiveUp: (reason: string) => void | Promise<void>;
}

/** Паузы по умолчанию: чужой `getUpdates` живёт до 30 с (наш timeout). */
export const POLLING_RETRY_DELAYS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

export function isConflictError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { error_code?: unknown }).error_code;
  if (code === 409) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\b409\b|Conflict/i.test(message);
}

export interface PollingState {
  /** Идёт ли приём команд прямо сейчас. Читает проверка здоровья. */
  running: boolean;
  /** Почему не идёт, если не идёт. */
  reason?: string;
}

export async function runPolling(deps: PollingDeps, state: PollingState): Promise<void> {
  const delays = deps.delays ?? POLLING_RETRY_DELAYS;
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }));

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      state.running = true;
      delete state.reason;
      await deps.start();
      // Цикл завершился сам (штатная остановка бота) — повторять нечего.
      state.running = false;
      state.reason = 'остановлен штатно';
      return;
    } catch (error) {
      state.running = false;
      const conflict = isConflictError(error);
      state.reason = conflict
        ? 'другой экземпляр держит getUpdates'
        : error instanceof Error
          ? error.message
          : String(error);

      const delay = delays[attempt];
      if (delay === undefined) break;
      deps.logger.warn(
        { attempt: attempt + 1, of: delays.length, conflict, delayMs: delay },
        'приём команд не запустился: повторю',
      );
      await sleep(delay);
    }
  }

  const reason = state.reason ?? 'неизвестно';
  deps.logger.error({ reason }, 'приём команд не поднялся: бот не отвечает на команды');
  await deps.onGiveUp(reason);
}
