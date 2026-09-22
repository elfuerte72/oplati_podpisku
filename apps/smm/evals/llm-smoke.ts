/**
 * Живой смоук модуля модели: один вызов роли `plan` на фикстурном досье.
 *
 * НЕ в CI: тратит деньги и требует живой ключ. Запуск —
 * `pnpm --filter smm eval:llm`.
 */

import { loadEnv } from '../src/config/env.ts';
import { smmConfig } from '../src/config/smm.config.ts';
import { createLogger } from '../src/logger.ts';
import { createModel, createModelClient } from '../src/llm/model.ts';
import { PlanSchema } from '../src/llm/schemas.ts';
import { openStore } from '../src/store/index.ts';

const DOSSIER = {
  title: 'Google открыла память Gemini бесплатным пользователям',
  facts: [
    {
      statement: 'Память включена всем бесплатным аккаунтам',
      quote: 'memory is now available to all users, including the free tier',
      url: 'https://blog.google/example',
    },
    {
      statement: 'Функция помнит прошлые разговоры без напоминаний',
      quote: 'Gemini can recall details from past conversations automatically',
    },
  ],
  numbers: [{ value: '2', unit: 'недели', what: 'сколько заняло раскатывание' }],
  dates: [{ date: '2026-09-18', what: 'объявление в блоге' }],
  reader_new: 'Не нужно каждый раз пересказывать контекст: помнит прошлые разговоры',
  works_in_russia: 'unknown',
  how_to_pay: 'unknown',
};

function rubricList(): string {
  return Object.values(smmConfig.rubrics)
    .map((rubric) => `- ${rubric.key} («${rubric.title}»): ${rubric.inside}`)
    .join('\n');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: 'info' });
  const store = openStore({ path: ':memory:' });
  const model = createModel({ client: createModelClient(env), env, usage: store.usage, logger });

  const input = [
    'Досье:',
    JSON.stringify(DOSSIER, null, 2),
    '',
    'Рубрики канала:',
    rubricList(),
    '',
    'Совет: новостей за последние десять постов больше плана, дефицит у рубрик «Как этим пользоваться» и «Сколько стоит и стоит ли».',
  ].join('\n');

  const started = Date.now();
  const result = await model.json('plan', input, PlanSchema);
  const ms = Date.now() - started;

  if (!result.ok) {
    console.error(`Провал (${result.reason}): ${result.message}`);
  } else {
    console.log(JSON.stringify(result.value, null, 2));
  }

  const month = new Date().toISOString().slice(0, 7);
  const usage = store.usage.sumByMonth(month);
  // Сырые поля учёта: маппинг usage у Anthropic-совместимого слоя DeepSeek не
  // документирован, и один живой прогон закрывает вопрос, считается ли
  // кэш-попадание внутри input_tokens.
  for (const row of store.db.all<Record<string, unknown>>('SELECT * FROM usage ORDER BY id')) {
    console.log('usage:', JSON.stringify(row));
  }
  console.log(
    `\nВызовов: ${usage.calls}, расход: $${(usage.usdMicros / 1_000_000).toFixed(6)}` +
      `${usage.hasUnknownPrice ? ' (оценка: тариф модели неизвестен)' : ''}, время: ${ms} мс`,
  );
  for (const role of usage.byRole) {
    console.log(`  ${role.role}: вход ${role.inputTokens}, выход ${role.outputTokens}`);
  }

  store.close();
  process.exit(result.ok ? 0 : 1);
}

await main();
