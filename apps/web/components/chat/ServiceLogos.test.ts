import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Логотипы сервисов, которые лежат картинками в `public/service-icons`.
 *
 * Читаем исходник как текст, а не импортируем компонент: тут проверяется не
 * рендер, а согласованность карты путей с файлами на диске. Битый путь ничего
 * не ломает — карточка сервиса просто рисуется без логотипа, и заметить это
 * можно только глазами на витрине.
 */

const SOURCE = readFileSync(join(import.meta.dirname, 'ServiceLogos.tsx'), 'utf8');
const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

function imageLogoEntries(): [string, string][] {
  const block = /const IMAGE_LOGOS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(SOURCE);
  if (!block?.[1]) throw new Error('не найден блок IMAGE_LOGOS');
  return [...block[1].matchAll(/^\s*'?([\w-]+)'?:\s*'([^']+)'/gm)].map(
    (m) => [m[1] as string, m[2] as string] satisfies [string, string],
  );
}

describe('IMAGE_LOGOS', () => {
  const entries = imageLogoEntries();

  it('карта не пустая (иначе регулярка ниже проверяла бы пустоту)', () => {
    expect(entries.length).toBeGreaterThan(5);
  });

  it.each(entries)('файл логотипа %s существует', (_slug, path) => {
    expect(path.startsWith('/service-icons/')).toBe(true);
    expect(existsSync(join(PUBLIC_DIR, path))).toBe(true);
  });

  it('HeyGen отдаётся в webp', () => {
    expect(Object.fromEntries(entries).heygen).toBe('/service-icons/heygen.webp');
  });
});
