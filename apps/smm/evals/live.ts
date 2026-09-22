import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Api } from 'grammy';

import { loadEnv } from '../src/config/env.ts';
import { createLogger } from '../src/logger.ts';
import { createModel, createModelClient } from '../src/llm/model.ts';
import { grammyApi } from '../src/render/send.ts';
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

/**
 * Сколько попыток на сценарий. ⚠️ Мусор — ОШИБКА, а не «одна попытка»:
 * `pass^N` это критерий готовности, и опечатка молча превращала его в один
 * прогон при зелёном выводе.
 */
function parseTrials(argv: readonly string[]): number {
  const flag = argv.findIndex((arg) => arg === '--trials' || arg.startsWith('--trials='));
  if (flag < 0) return 1;
  const raw = argv[flag]?.startsWith('--trials=') === true
    ? (argv[flag] ?? '').slice('--trials='.length)
    : (argv[flag + 1] ?? '');
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--trials ожидает целое число больше нуля, получено «${raw}»`);
  }
  return value;
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

  // ⚠️ Отчёт пишется в `finally`: исключение на последнем сценарии иначе
  // теряет результаты всех предыдущих вместе с их ценой.
  try {
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
      const api = grammyApi(new Api(env.botToken));
      const started = Date.now();
      const outcome = await runScenario(
        // Живая модель и живые страницы: записанные ответы не подставляем.
        { ...scenario, model: {}, pages: {} },
        { channelId, live: { model, store, api } },
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

  } finally {
  const day = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
}

await main();
