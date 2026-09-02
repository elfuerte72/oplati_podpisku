import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listSchemaTables } from '@oplati/db';

import { PANEL_AI_SCHEMA, renderSchemaDictionary } from './schema-dictionary';
import { buildPanelAnalystSystemPrompt } from './system-prompt';

/**
 * Словарь схемы аналитика ↔ грант роли `panel_ai_ro` — зеркало (инвариант 10),
 * и держится оно тестом, а не глазами: таблица без описания даёт модели
 * `permission denied` там, где она честно спросила словарь; описание без гранта
 * заставляет её выдумывать данные, которых у роли нет.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const roleSql = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'scripts', 'panel-ai-role.sql'),
  'utf8',
);

/** Гранты файла: имя объекта → колонки (`null` — таблица целиком). */
function parseGrants(sql: string): Map<string, string[] | null> {
  const statements = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('GRANT SELECT'));
  const out = new Map<string, string[] | null>();
  for (const st of statements) {
    const full = /^GRANT SELECT ON (\w+) TO/.exec(st);
    if (full) {
      out.set(full[1]!, null);
      continue;
    }
    const cols = /^GRANT SELECT \(([^)]+)\)\s+ON (\w+) TO/s.exec(st);
    if (cols) {
      out.set(
        cols[2]!,
        cols[1]!.split(',').map((c) => c.trim()).filter(Boolean),
      );
    }
  }
  return out;
}

/** Таблицы Drizzle: имя → колонки. Вьюх в schema.ts нет — их словарь описывает сам. */
function drizzleTables(): Map<string, Set<string>> {
  return new Map([...listSchemaTables()].map(([name, cols]) => [name, new Set(cols)]));
}

describe('словарь схемы ↔ грант роли panel_ai_ro', () => {
  const grants = parseGrants(roleSql);
  const dictionary = new Map(PANEL_AI_SCHEMA.map((e) => [e.table, e]));

  it('каждая таблица словаря выдана роли, каждая выданная — описана', () => {
    const inDictionary = [...dictionary.keys()].sort();
    const granted = [...grants.keys()].sort();
    expect(inDictionary).toEqual(granted);
  });

  it('колонки словаря — подмножество выданных: у колоночных грантов лишней колонки в словаре нет', () => {
    for (const entry of PANEL_AI_SCHEMA) {
      const granted = grants.get(entry.table);
      if (!granted) continue; // таблица целиком — ограничений нет
      for (const col of entry.columns) {
        expect(granted, `${entry.table}.${col.name}`).toContain(col.name);
      }
      // И наоборот: выданная колонка описана — иначе модель о ней не узнает.
      for (const col of granted) {
        expect(entry.columns.map((c) => c.name), `${entry.table}.${col}`).toContain(col);
      }
    }
  });

  it('колонки словаря существуют в schema.ts — выдуманной колонки быть не может', () => {
    const tables = drizzleTables();
    for (const entry of PANEL_AI_SCHEMA) {
      if (entry.kind !== 'table') continue;
      const real = tables.get(entry.table);
      expect(real, entry.table).toBeDefined();
      for (const col of entry.columns) {
        expect(real?.has(col.name), `${entry.table}.${col.name}`).toBe(true);
      }
      // Таблица целиком — словарь описывает КАЖДУЮ колонку, иначе модель
      // спросит про существующую и получит «нет такой колонки» из словаря.
      if (grants.get(entry.table) === null) {
        for (const col of real ?? []) {
          expect(entry.columns.map((c) => c.name), `${entry.table}.${col}`).toContain(col);
        }
      }
    }
  });

  it('недоступное названо явно — контакты, переписка, сырой снимок провайдера', () => {
    const text = renderSchemaDictionary();
    expect(text).toMatch(/messages/);
    expect(text).toMatch(/email/);
    expect(text).toMatch(/raw_payload/);
    expect(text).toMatch(/недоступн/i);
  });
});

describe('системный промпт аналитика', () => {
  const INFORMAL =
    /(?<![а-яё])(обнови|попробуй|посмотри|проверь|ты|тебе|тебя|твой|твоей|твою)(?![а-яё])/i;

  it('подставляет дату, правила денег и статус-машину', () => {
    const prompt = buildPanelAnalystSystemPrompt({ today: '2026-09-02' });
    expect(prompt).toContain('Сегодня 2026-09-02');
    expect(prompt).toContain('копейки');
    expect(prompt).toContain('pending_payment → paid, expired, cancelled, failed, payment_review');
    expect(prompt).toContain('count(DISTINCT subject_key)');
  });

  it('безличный тон, без Sentry и без эмодзи', () => {
    const prompt = buildPanelAnalystSystemPrompt({ today: '2026-09-02' });
    for (const line of prompt.split('\n')) {
      expect(INFORMAL.test(line), line).toBe(false);
    }
    expect(prompt).not.toMatch(/sentry/i);
    expect(prompt).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
