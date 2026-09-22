import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень `src` бота. Считается от файла, а не от cwd: vitest запускают из разных мест. */
export const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Корень пакета: канарейки смотрят и на evals, scripts и конфиги, а не только на src. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface SourceFile {
  /** Путь от корня пакета, всегда со слэшами: сравнения не должны зависеть от платформы. */
  readonly path: string;
  readonly code: string;
}

const CODE_EXT = ['.ts', '.mts', '.mjs', '.js'];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && CODE_EXT.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function toSourceFile(full: string): SourceFile {
  return {
    path: relative(PACKAGE_ROOT, full).split(sep).join('/'),
    code: readFileSync(full, 'utf8'),
  };
}

/**
 * Файлы кода пакета. Канарейки ходят по исходникам, а не по памяти автора: линт
 * отключается строкой `eslint-disable`, а тест — нет.
 *
 * `scope: 'src'` — только `src/**` без тестов (для правил вида «кто может
 * импортировать grammY»), `scope: 'package'` — весь пакет вместе с тестами,
 * evals, scripts и конфигами (для правил границ, которые нельзя обойти нигде).
 */
export function sourceFiles(options: { scope?: 'src' | 'package' } = {}): SourceFile[] {
  const scope = options.scope ?? 'src';
  if (scope === 'package') {
    const roots = ['src', 'evals', 'scripts']
      .map((dir) => join(PACKAGE_ROOT, dir))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
    const files = roots.flatMap((dir) => walk(dir, []));
    const configs = ['vitest.config.ts', 'eslint.config.mjs']
      .map((name) => join(PACKAGE_ROOT, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
    return [...files, ...configs].map(toSourceFile).sort((a, b) => a.path.localeCompare(b.path));
  }

  return walk(SRC_ROOT, [])
    .map(toSourceFile)
    .filter((file) => !file.path.endsWith('.test.ts'))
    .filter((file) => !file.path.startsWith('src/testing/'))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Адреса, из которых файл что-то тянет. Ловит все четыре формы, включая
 * побочный `import 'x';` без `from` и динамический `import('x')` — их линт
 * `no-restricted-imports` не видит вовсе.
 */
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Код без комментариев. Канарейкам по тексту нужен именно он: объяснение
 * правила в комментарии («прямой UPDATE posts SET status запрещён») иначе
 * само считается нарушением этого правила.
 */
export function codeWithoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

export function importsOf(code: string): string[] {
  const out = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) out.add(specifier);
    }
  }
  return [...out];
}
