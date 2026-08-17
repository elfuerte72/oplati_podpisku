import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Модули, которые РЕАЛЬНО читает клиентский компонент панели: тяжёлые
    // зависимости отсюда уезжают в браузер. Держится правилом, а не памятью —
    // обоснование в комментарии файла зелёный прогон не проверяет, а линт
    // проверяет. Список сверять с импортами файлов под 'use client'
    // (components/panel/*): защищать не тот файл — самообман.
    files: [
      "lib/panel/fulfillment.ts",
      "lib/panel/live.ts",
      "lib/panel/format.ts",
      "lib/panel/support.ts",
      "lib/retention-policy.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "zod",
              message:
                "Модуль читает клиентский компонент. Разбор границы запроса делается в route-handler'е, а не здесь.",
            },
            {
              name: "server-only",
              message: "Модуль читает клиентский компонент — серверных зависимостей тут быть не может.",
            },
            {
              name: "@oplati/db",
              message: "Модуль читает клиентский компонент — доступ к БД тут невозможен.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
