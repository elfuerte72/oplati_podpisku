import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Границы пакета форсятся линтом, а не памятью: бот живёт ВНЕ контура приложения
// (правило CLAUDE.md «Границы пакетов»). Импорт `@oplati/db` дал бы боту прямое
// подключение к боевому Postgres, импорт из `apps/web` — кросс-импорт между
// приложениями, который в этом репозитории запрещён целиком. Ни то, ни другое
// не падает в тестах: код просто начинает работать иначе, поэтому проверка тут.
export default tseslint.config(
  { ignores: ['dist/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'evals/**/*.ts', 'scripts/**/*.mjs', '*.ts', '*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@oplati/*'],
              message:
                'Бот вне контура приложения: ни @oplati/db, ни @oplati/types. Своё состояние — SQLite в src/store.',
            },
            {
              // Регэксп, а не group: `group` считает шаги `..` буквально, и из
              // src/a/b/c.ts путь `../../../web/lib/x` проходил мимо правила.
              regex: '(^|/)\\.\\.(/\\.\\.)*/web/',
              message: 'Кросс-импорты между apps/* запрещены (CLAUDE.md).',
            },
            {
              group: ['**/apps/web/**'],
              message: 'Кросс-импорты между apps/* запрещены (CLAUDE.md).',
            },
          ],
        },
      ],
      // Ошибки не глотаем (CLAUDE.md): пустой catch запрещён.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Тестам и скриптам сборки console разрешён: у них нет логгера и нет прода.
    files: ['src/**/*.test.ts', 'src/testing/**/*.ts', 'evals/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // Скрипты сборки — обычный node-скрипт без tsconfig: глобалы объявляем сами,
    // иначе no-undef ругается на console и process.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
