import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Тот же JSX-рантайм, что у Next (automatic): серверные компоненты панели не
  // импортируют React, и с `jsx: preserve` из tsconfig esbuild собирал бы их
  // под classic-рантайм — «React is not defined» в тестах рендера в строку.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'components/**/*.test.ts'],
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
