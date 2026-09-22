import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { migrate, openDb, type AppliedMigration, type Db } from './db.ts';
import { createPostsRepo, type PostsRepo } from './posts.ts';
import {
  createFlowRepo,
  createItemsRepo,
  createOfftopicRepo,
  createSettingsRepo,
  createUsageRepo,
  type FlowRepo,
  type ItemsRepo,
  type OfftopicRepo,
  type SettingsRepo,
  type UsageRepo,
} from './repos.ts';

export * from './types.ts';
export { POST_STATUSES, IN_PROGRESS_STATUSES, isTerminal, type PostStatus } from './post-state.ts';
export { ulid } from './ulid.ts';

export interface Store {
  readonly posts: PostsRepo;
  readonly flow: FlowRepo;
  readonly items: ItemsRepo;
  readonly usage: UsageRepo;
  readonly settings: SettingsRepo;
  readonly offtopic: OfftopicRepo;
  /** Применённые при открытии миграции: их печатает строка старта. */
  readonly applied: readonly AppliedMigration[];
  /** Прямой доступ — только для проверки здоровья и статистики просмотров. */
  readonly db: Db;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenStoreOptions {
  readonly path: string;
  /** Часы. Тесты замораживают время, чтобы проверять окна и порядок решений. */
  readonly now?: () => Date;
}

export class StoreOpenError extends Error {
  override readonly name = 'StoreOpenError';
}

export function openStore(options: OpenStoreOptions): Store {
  const now = options.now ?? ((): Date => new Date());

  if (options.path !== ':memory:') {
    try {
      mkdirSync(dirname(options.path), { recursive: true });
    } catch (error) {
      // Права на каталог тома — самая частая причина мёртвого старта:
      // смонтированный том остаётся root-овым, а процесс идёт под node.
      throw new StoreOpenError(
        `не удалось создать каталог для базы (${dirname(options.path)}): ${String(error)}. ` +
          'Проверь права на том: контейнер работает не под root.',
      );
    }
  }

  let db: Db;
  try {
    db = openDb(options.path);
  } catch (error) {
    throw new StoreOpenError(`база ${options.path} не открылась: ${String(error)}`);
  }

  const applied = migrate(db, now);

  return {
    posts: createPostsRepo(db, now),
    flow: createFlowRepo(db, now),
    items: createItemsRepo(db, now),
    usage: createUsageRepo(db, now),
    settings: createSettingsRepo(db, now),
    offtopic: createOfftopicRepo(db, now),
    applied,
    db,
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
