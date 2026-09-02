import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Конфиг для eval-скриптов с ЖИВЫМ ключом модели и dev-БД (`scripts/*.eval.ts`).
 *
 * Отдельный от `vitest.config.ts` намеренно: обычный `pnpm test` их не видит и
 * в CI они не гоняются — ходят во внешний API и стоят денег. Запуск руками:
 * `pnpm --filter web eval:panel-ai`. Общий с тестами setup глушит `server-only`,
 * поэтому eval может звать те же модули, что и приложение.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['scripts/**/*.eval.ts'],
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    // Живая модель отвечает секундами, восемь итераций — до минуты на кейс.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
