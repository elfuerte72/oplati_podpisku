import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // PGlite поднимает WASM-Postgres и гоняет реальные миграции — щедрый таймаут.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
