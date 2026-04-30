/**
 * Минимальный logger-интерфейс для repository-слоя.
 *
 * `@oplati/db` не должен зависеть от pino напрямую — это нарушит границу пакета
 * (см. docs/repo-structure.md). Вместо этого репозитории принимают любой объект,
 * совместимый по форме с pino: `{ debug, info, warn }` от `(obj: object) => void`.
 *
 * `apps/web` передаёт сюда `childLogger('db')` (pino-инстанс) — формы совпадают.
 * Тестовые/CLI-окружения могут передать `noopLogger`, чтобы не привязываться к pino.
 */

export type RepoLogger = {
  debug: (obj: object) => void;
  info: (obj: object) => void;
  warn: (obj: object) => void;
};

export const noopLogger: RepoLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
};
