import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Статические HTML-страницы (`public/*.html`) — маркетинговый лендинг партнёрки
 * и инструкция по оплате. Они лежат мимо сборки Next.js: их никто не
 * компилирует, пути внутри не проверяются ни типами, ни линтером, ни билдом.
 *
 * Чем это кончилось: маскота перевели в WebP (PR #90, 2026-07-19), а ссылки в
 * этих двух файлах остались на `.png`. Обе страницы показывали клиентам иконки
 * битых картинок вместо иллюстраций, и заметить это можно было только открыв
 * страницу глазами — что и произошло 2026-07-27.
 *
 * Тест дёшев и закрывает весь класс: любая ссылка на локальный файл из этих
 * страниц обязана указывать на существующий файл.
 *
 * ⚠️ Сам тест живёт в `lib/`, а не рядом со страницами: всё, что лежит в
 * `public/`, раздаётся по HTTP — тест-файл там стал бы публично скачиваемым.
 */

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

/** Локальные ссылки страницы: `src`/`href`, начинающиеся с `/`. Внешние URL пропускаем. */
function localRefs(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/[^"#?]+)(?:\?[^"]*)?"/g)].map((m) => m[1] as string);
}

const pages = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

describe('статические страницы в public/', () => {
  it('страницы на месте (иначе тест ниже проверял бы пустоту)', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)('%s: все локальные ссылки ведут на существующие файлы', (page) => {
    const refs = localRefs(readFileSync(join(PUBLIC_DIR, page), 'utf8'));
    const broken = refs.filter((ref) => !existsSync(join(PUBLIC_DIR, ref.slice(1))));
    expect(broken, `битые ссылки в ${page}`).toEqual([]);
  });
});
