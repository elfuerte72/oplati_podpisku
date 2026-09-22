import { describe, expect, it } from 'vitest';

import { loadScenarios, runScenario } from './harness.ts';

/**
 * Сценарии диалога в CI. Гоняются на ЗАПИСАННЫХ ответах модели и страницах
 * источников: прогон детерминированный, денег не стоит и ловит ровно то, что
 * ломали правки автомата — путь от команды владельца до канала.
 */

const scenarios = loadScenarios();

describe('сценарии диалога', () => {
  it('сценарии вообще есть: пустой каталог — это зелёный прогон ни о чём', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
    for (const scenario of scenarios) {
      // У каждого сценария есть причина существовать, а не только имя.
      expect(scenario.why.length, scenario.name).toBeGreaterThan(20);
    }
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const outcome = await runScenario(scenario);
      expect(outcome.failures, outcome.failures.join('\n')).toEqual([]);
    });
  }
});
