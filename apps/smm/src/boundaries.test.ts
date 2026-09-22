import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importsOf, sourceFiles } from './testing/source-files.ts';

/**
 * Границы пакета. Линт их тоже держит (`eslint.config.mjs`), но линт легко
 * отключить строкой `eslint-disable`, а канарейка ходит по исходникам и не
 * спрашивает разрешения.
 */
describe('границы apps/smm', () => {
  /** Ссылка на соседнее приложение в любой форме: по имени пакета или шагами `..`. */
  const WEB_IMPORT = /(?:^|\/)\.\.(?:\/\.\.)*\/web\/|apps\/web/;

  it('ничего из @oplati/* и из apps/web не импортируется', () => {
    const offenders: string[] = [];
    // Сам файл канарейки исключён: ниже лежат ОБРАЗЦЫ запрещённых импортов
    // строками, и проверка ловила бы их как нарушение. Настоящий импорт здесь
    // поймает линт — правило границ распространяется и на тесты.
    for (const file of sourceFiles({ scope: 'package' }).filter(
      (f) => f.path !== 'src/boundaries.test.ts',
    )) {
      for (const specifier of importsOf(file.code)) {
        if (specifier.startsWith('@oplati/') || WEB_IMPORT.test(specifier)) {
          offenders.push(`${file.path} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('канарейка ловит запрещённый импорт в любой форме', () => {
    // Сама канарейка обязана быть проверена: молчащая проверка хуже отсутствия.
    const samples = [
      "import { getDb } from '@oplati/db';",
      "import '@oplati/db';",
      "export * from '@oplati/db/schema';",
      "const db = await import('@oplati/db');",
      "import { x } from '../../../web/lib/env.ts';",
      "import { y } from '../../web/lib/env.ts';",
      "import { z } from '../../../../apps/web/lib/env.ts';",
    ];
    for (const sample of samples) {
      const found = importsOf(sample);
      expect(found.length, sample).toBeGreaterThan(0);
      expect(
        found.some((s) => s.startsWith('@oplati/') || WEB_IMPORT.test(s)),
        sample,
      ).toBe(true);
    }
  });

  it('grammY живёт только там, где действительно говорит с Telegram', () => {
    // Линт, рендер и конвейер обязаны быть чистыми: их тесты не должны
    // поднимать клиент Bot API, чтобы проверить правило текста.
    const allowed = [
      /^src\/bot\//,
      /^src\/render\/send\.ts$/,
      /^src\/main\.ts$/,
      /^src\/alerts\//,
      /^src\/health\//,
    ];
    const offenders = sourceFiles()
      .filter((file) => importsOf(file.code).some((s) => s === 'grammy' || s.startsWith('grammy/')))
      .map((file) => file.path)
      .filter((path) => !allowed.some((rule) => rule.test(path)));
    expect(offenders).toEqual([]);
  });

  it('прямого fetch без обёртки с таймаутом в коде нет', () => {
    // Правило CLAUDE.md: fetch без таймаута запрещён, и таймаут обязан покрывать
    // чтение ТЕЛА. Единственное место, где живёт голый fetch, — src/sources/http.ts.
    const allowed = [/^src\/sources\/http\.ts$/];
    const offenders = sourceFiles()
      .filter((file) => /(?<![.\w])fetch\s*\(/.test(file.code))
      .map((file) => file.path)
      .filter((path) => !allowed.some((rule) => rule.test(path)));
    expect(offenders).toEqual([]);
  });

  it('у пакета есть скрипт test, иначе CI его молча пропустит', () => {
    // Грабли из CLAUDE.md: `pnpm -r --if-present test` пропускает пакет без
    // скрипта, и packages/agent так числился покрытым, не гоняясь месяцами.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    expect(manifest.scripts?.test).toBeTruthy();
    expect(manifest.scripts?.typecheck).toBeTruthy();
    expect(manifest.scripts?.lint).toBeTruthy();
    expect(manifest.scripts?.build).toBeTruthy();
    // Зависимости бота закрыты спекой: ничего из контура приложения.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@anthropic-ai/sdk',
      'grammy',
      'pino',
      'zod',
    ]);
  });
});
