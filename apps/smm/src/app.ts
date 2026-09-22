import { createSmmBot, type SmmBot } from './bot/bot.ts';
import type { SmmEnv } from './config/env.ts';
import { createModel, createModelClient } from './llm/model.ts';
import { warmPrompts } from './llm/prompts.ts';
import type { Logger } from './logger.ts';
import { openStore, type Store } from './store/index.ts';

export interface AppDeps {
  readonly env: SmmEnv;
  readonly logger: Logger;
  /** Готовое хранилище. Тесты передают `:memory:`-вариант, прод — открывает сам. */
  readonly store?: Store;
  /** Не поднимать бота: нужно тестам и eval, которые гоняют конвейер без Telegram. */
  readonly withoutBot?: boolean;
}

export interface RunningApp {
  readonly store: Store;
  readonly bot?: SmmBot;
  /** Остановить всё, что запущено: бот, тикеры, база. Идемпотентна. */
  stop(): Promise<void>;
}

/**
 * Сборка бота: здесь сходятся store, модель, конвейер и бот. Тикеры источников
 * (тикет 10), просмотров (тикет 11) и здоровья (тикет 12) подключаются сюда же.
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

  const model = createModel({
    client: createModelClient(env),
    env,
    usage: store.usage,
    logger,
  });

  const bot =
    deps.withoutBot === true
      ? undefined
      : createSmmBot({ env, store, logger, pipeline: { model, logger } });

  logger.info(
    {
      channel: env.channelId,
      undoSeconds: env.publishUndoSeconds,
      models: { writer: env.model.writer, judge: env.model.judge, rank: env.model.rank },
      migrations: store.applied.map((m) => m.name),
      promptRoles,
      bot: bot !== undefined,
    },
    'бот SMM поднялся',
  );

  if (bot !== undefined) {
    void bot.start().catch((error: unknown) => {
      logger.error({ err: error }, 'бот не поднялся');
    });
  }

  let stopped = false;
  return {
    store,
    ...(bot === undefined ? {} : { bot }),
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (bot !== undefined) await bot.stop();
      // Базу закрываем только если открывали сами: чужую закрыл бы тест под собой.
      if (!externalStore) store.close();
      logger.info('бот SMM остановлен');
    },
  };
}
