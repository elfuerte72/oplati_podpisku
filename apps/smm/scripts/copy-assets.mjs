import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc копирует только .ts. Промпты ролей (.md) и миграции (.sql) грузятся в
// рантайме относительно своего модуля, поэтому в dist они обязаны лежать рядом
// с ним: без этого шага собранный образ падает на первом же вызове модели или
// на первой миграции.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/llm/prompts', 'dist/llm/prompts', '.md'],
  ['src/store/migrations', 'dist/store/migrations', '.sql'],
];

for (const [from, to, ext] of assets) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.log(`assets: ${from} — каталога нет, пропускаю`);
    continue;
  }
  const files = readdirSync(source).filter((name) => name.endsWith(ext));
  if (files.length === 0) {
    console.log(`assets: ${from} — файлов ${ext} нет, пропускаю`);
    continue;
  }
  mkdirSync(join(root, to), { recursive: true });
  for (const name of files) {
    // Копируем поимённо, а не каталог целиком: рекурсивный cpSync унёс бы в dist
    // и соседние .ts, которые там уже скомпилированы.
    cpSync(join(source, name), join(root, to, name));
  }
  console.log(`assets: ${from} -> ${to} (${files.length})`);
}
