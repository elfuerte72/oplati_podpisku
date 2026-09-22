import type { SmmEnv } from './config/env.ts';
import { warmPrompts } from './llm/prompts.ts';
import type { Logger } from './logger.ts';
import { openStore, type Store } from './store/index.ts';

export interface AppDeps {
  readonly env: SmmEnv;
  readonly logger: Logger;
  /** Готовое хранилище. Тесты передают `:memory:`-вариант, прод — открывает сам. */
  readonly store?: Store;
}

export interface RunningApp {
  readonly store: Store;
  /** Остановить всё, что запущено: бот, тикеры, база. Идемпотентна. */
  stop(): Promise<void>;
}

/**
 * Сборка бота: здесь сходятся store, бот и диалог (тикет 08), тикеры источников
 * (тикет 10), просмотров (тикет 11) и здоровья (тикет 12).
 *
 * Держится отдельно от `main.ts`, потому что `main.ts` — точка входа процесса
 * (сигналы, код выхода), а сборку надо уметь запускать из теста и из eval.
 */
export function startApp(deps: AppDeps): RunningApp {
  const { env, logger } = deps;
  // Миграции применяются при открытии базы: отдельного шага деплоя у бота нет,
  // и «деплой не применил миграции» — ровно тот инцидент, который стоил проду
  // отказа первого счёта Freekassa.
  const externalStore = deps.store !== undefined;
  const store = deps.store ?? openStore({ path: env.dbPath });
  // Промпты ролей читаются ЗДЕСЬ, при старте: недостающий в образе файл обязан
  // ронять деплой, а не первый пост в три часа ночи.
  const promptRoles = Object.keys(warmPrompts()).length;

  logger.info(
    {
      channel: env.channelId,
      undoSeconds: env.publishUndoSeconds,
      models: { writer: env.model.writer, judge: env.model.judge, rank: env.model.rank },
      migrations: store.applied.map((m) => m.name),
      promptRoles,
    },
    'бот SMM поднялся',
  );

  let stopped = false;
  return {
    store,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Базу закрываем только если открывали сами: чужую закрыл бы тест под собой.
      if (!externalStore) store.close();
      logger.info('бот SMM остановлен');
    },
  };
}
