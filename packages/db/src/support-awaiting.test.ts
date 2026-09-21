import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Канарейка зеркала «обращение ждёт человека» (crm-serious-fixes, тикет 03).
 *
 * Поведение трёх читателей правила проверяет `support.integration.test.ts`
 * одной таблицей сценариев. Но таблица ловит разъезд только на тех сценариях,
 * что в ней есть: вторая копия условия, отличающаяся в непокрытом углу, прошла
 * бы её молча. До тикета так и было — у крона было своё правило (обязательный
 * режим `operator`), и весь поток прода сторож не видел, при зелёных тестах.
 *
 * Здесь проверяется ИСТОЧНИК: каждый из троих зовёт общий фрагмент, и ни в
 * одном файле нет рукописной копии условия. Приём — как у `promo-locks.test.ts`
 * и `panel-css.test.ts`: дефект, который сам не падает, делаем заметным.
 */

const REPOS = join(import.meta.dirname, 'repositories');
const PANEL = readFileSync(join(REPOS, 'panel.ts'), 'utf8');
const SUPPORT = readFileSync(join(REPOS, 'support.ts'), 'utf8');

/** Тело экспортированной функции — до следующего экспорта. */
function body(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `функция ${name} не найдена`).toBeGreaterThan(0);
  const end = source.indexOf('\nexport ', start + 1);
  return source.slice(start, end > 0 ? end : undefined);
}

describe('правило «ждёт человека» — один фрагмент на троих', () => {
  it.each([
    ['список /admin/support', PANEL, 'listSupportRequestsForPanel'],
    ['счётчик меню и рабочего стола', PANEL, 'countUnansweredSupportRequests'],
    ['сторож крона «без ответа»', SUPPORT, 'findUnansweredSupportConversations'],
    // Кнопка «Отвечено» рисуется по флагу списка — своё правило у операции
    // означало бы кнопку, которая отвечает отказом.
    ['ручная отметка «отвечено»', SUPPORT, 'markSupportRequestAnswered'],
  ])('%s зовёт awaitingOperatorSql и общий маркер', (_name, source, fn) => {
    const text = body(source, fn);
    expect(text).toContain('awaitingOperatorSql(');
    expect(text).toContain('supportRequestMarkerSql(');
    expect(text).toContain('lastSupportRequestSourceSql(');
  });

  it('рукописных копий условия в репозиториях нет', () => {
    for (const source of [PANEL, SUPPORT]) {
      // Прежние формы: своё «режим operator ИЛИ флоу без режима» и свой
      // «нет ответа оператора позже обращения» рядом с общим фрагментом.
      expect(source).not.toMatch(/handoff_mode\s*=\s*'operator'\s+OR/);
      expect(source).not.toMatch(/o\.role\s*=\s*'operator'\s*\n?\s*AND\s+o\.created_at\s*>\s*a\.last_client_at/);
      expect(source).not.toContain('LEGACY_SUPPORT_SOURCE');
      expect(source).not.toContain('awaitingOperatorCondition');
    }
  });
});
