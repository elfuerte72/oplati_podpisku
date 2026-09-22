import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/config/env.ts';
import { createLogger } from '../src/logger.ts';
import { createModel, createModelClient } from '../src/llm/model.ts';
import { openStore } from '../src/store/index.ts';
import { loadScenarios, runScenario } from './harness.ts';

/**
 * Живой прогон сценариев: та же таблица шагов, но против НАСТОЯЩЕЙ модели и
 * настоящих страниц. В CI не ходит — он стоит денег и требует ключей.
 *
 * ⚠️ Публикация идёт в ТЕСТОВЫЙ канал `SMM_EVAL_CHANNEL_ID`. Без него прогон
 * не стартует вовсе: единственная ошибка тут — пост в боевой канал, и она
 * необратима.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface TrialReport {
  readonly scenario: string;
  readonly trial: number;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly ms: number;
  readonly usdMicros: number;
  readonly calls: number;
}

function parseTrials(argv: readonly string[]): number {
  const flag = argv.indexOf('--trials');
  if (flag < 0) return 1;
  const value = Number(argv[flag + 1]);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const channelId = env.evalChannelId;
  if (channelId === undefined || channelId === '') {
    console.error('SMM_EVAL_CHANNEL_ID не задан: живой прогон публикует посты и в боевой канал не пойдёт.');
    process.exitCode = 1;
    return;
  }
  if (channelId === env.channelId) {
    console.error('SMM_EVAL_CHANNEL_ID совпадает с боевым каналом: прогон остановлен.');
    process.exitCode = 1;
    return;
  }

  const trials = parseTrials(process.argv.slice(2));
  const logger = createLogger({ level: env.logLevel });
  const scenarios = loadScenarios();
  const reports: TrialReport[] = [];

  for (const scenario of scenarios) {
    for (let trial = 1; trial <= trials; trial += 1) {
      // Своё хранилище на попытку: расход считается по нему, а не по общей
      // сумме — иначе pass^N печатает одну цену на все прогоны.
      const store = openStore({ path: ':memory:' });
      const model = createModel({
        client: createModelClient(env),
        env,
        usage: store.usage,
        logger,
      });
      const started = Date.now();
      const outcome = await runScenario(
        // Живая модель и живые страницы: записанные ответы не подставляем.
        { ...scenario, model: {}, pages: {} },
        { channelId, live: { model, store } },
      );
      const spend = store.usage.sumByMonth(new Date().toISOString().slice(0, 7));
      reports.push({
        scenario: scenario.name,
        trial,
        ok: outcome.ok,
        failures: outcome.failures,
        ms: Date.now() - started,
        usdMicros: spend.usdMicros,
        calls: spend.calls,
      });
      store.close();
      console.log(
        `${outcome.ok ? 'ok  ' : 'FAIL'} ${scenario.name} (попытка ${trial}/${trials}, ` +
          `$${(spend.usdMicros / 1_000_000).toFixed(4)}, ${Date.now() - started} мс)`,
      );
      for (const failure of outcome.failures) console.log(`     ${failure}`);
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const path = join(HERE, 'reports', `${day}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), trials, reports }, null, 2) + '\n');
  console.log(`отчёт: ${path}`);

  const failed = reports.filter((report) => !report.ok);
  if (failed.length > 0) {
    console.error(`провалов: ${failed.length} из ${reports.length}`);
    process.exitCode = 1;
  }
}

await main();
