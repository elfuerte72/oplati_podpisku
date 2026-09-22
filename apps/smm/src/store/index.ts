import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { migrate, MigrationError, openDb, type AppliedMigration, type Db } from './db.ts';
import { createPostsRepo, type OnCorruptJson, type PostsRepo } from './posts.ts';
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
export {
  allowedTransitions,
  DECISION_KINDS,
  IN_PROGRESS_STATUSES,
  isTerminal,
  isTransitionAllowed,
  POST_STATUSES,
  type DecisionActor,
  type DecisionKind,
  type PostStatus,
} from './post-state.ts';
export { matchesSha8, sha8Of, SHA8_LENGTH, textShaOf } from './text-sha.ts';
export { ulid, ulidTime } from './ulid.ts';
export { MigrationError } from './db.ts';
export type { OnCorruptJson } from './posts.ts';

export interface Store {
  readonly posts: PostsRepo;
  readonly flow: FlowRepo;
  readonly items: ItemsRepo;
  readonly usage: UsageRepo;
  readonly settings: SettingsRepo;
  readonly offtopic: OfftopicRepo;
  /** Применённые при открытии миграции: их печатает строка старта. */
  readonly applied: readonly AppliedMigration[];
  /** Прямой доступ — только для проверки здоровья. Выборки живут в репозиториях. */
  readonly db: Db;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenStoreOptions {
  readonly path: string;
  /** Часы. Тесты замораживают время, чтобы проверять окна и порядок решений. */
  readonly now?: () => Date;
  /**
   * Куда сообщать о негодном JSON в колонке. Поле, которое не разобралось,
   * не роняет показ поста, но и молчать о нём нельзя: записывает его только
   * наш код, значит это симптом ручной правки базы.
   */
  readonly onCorruptJson?: OnCorruptJson;
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

  let applied: readonly AppliedMigration[];
  try {
    applied = migrate(db, now);
  } catch (error) {
    db.close();
    // Причина миграции уже объяснена в MigrationError; заворачивать её второй
    // раз незачем, но закрыть базу обязаны — иначе файл остаётся заблокирован.
    if (error instanceof MigrationError) throw error;
    throw new StoreOpenError(`миграции не применились: ${String(error)}`);
  }

  return {
    posts: createPostsRepo(db, now, options.onCorruptJson),
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
