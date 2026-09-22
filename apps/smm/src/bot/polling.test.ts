import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.ts';
import { isConflictError, runPolling, type PollingState } from './polling.ts';

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

/** Ошибка grammY на 409: так её видит наш код. */
function conflict(): Error & { error_code: number } {
  const error = Object.assign(
    new Error("Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request)"),
    { error_code: 409 },
  );
  return error;
}

describe('распознавание конфликта', () => {
  it('ловит 409 и по коду, и по тексту', () => {
    expect(isConflictError(conflict())).toBe(true);
    expect(isConflictError(new Error('409: Conflict'))).toBe(true);
    expect(isConflictError(new Error('сеть отвалилась'))).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });
});

describe('запуск приёма команд', () => {
  it('после конфликта на выкате повторяет и поднимается', async () => {
    // Swarm держит старый контейнер рядом с новым: первая попытка проигрывает
    // гонку за getUpdates, вторая выигрывает.
    let attempts = 0;
    const state: PollingState = { running: false };
    const slept: number[] = [];

    // ⚠️ Промис НЕ ждём: успешный цикл long polling не возвращается никогда,
    // как и в бою. Проверяем состояние после того, как дойдёт вторая попытка.
    void runPolling(
      {
        start: () => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(conflict());
          return new Promise<void>(() => {
            // Успешный цикл не возвращается — как настоящий long polling.
          });
        },
        logger: silent(),
        delays: [10, 20],
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        onGiveUp: () => {
          throw new Error('сдаваться было рано');
        },
      },
      state,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
    expect(slept).toEqual([10]);
    expect(state.running).toBe(true);
  });

  it('исчерпав попытки, ГРОМКО сообщает: бот глух', async () => {
    const state: PollingState = { running: false };
    const shouts: string[] = [];

    await runPolling(
      {
        start: () => Promise.reject(conflict()),
        logger: silent(),
        delays: [1, 1],
        sleep: () => Promise.resolve(),
        onGiveUp: (reason) => {
          shouts.push(reason);
        },
      },
      state,
    );

    expect(shouts).toHaveLength(1);
    expect(shouts[0]).toContain('getUpdates');
    // ⚠️ Главное: состояние честное. Сервис «1/1» и зелёная проверка здоровья
    // не должны означать «команды принимаются».
    expect(state.running).toBe(false);
    expect(state.reason).toBeDefined();
  });

  it('штатная остановка повтором не считается', async () => {
    const state: PollingState = { running: false };
    let giveUps = 0;

    await runPolling(
      {
        start: () => Promise.resolve(),
        logger: silent(),
        delays: [1],
        sleep: () => Promise.resolve(),
        onGiveUp: () => {
          giveUps += 1;
        },
      },
      state,
    );

    expect(giveUps).toBe(0);
    expect(state.running).toBe(false);
  });
});
