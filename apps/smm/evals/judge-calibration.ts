import { loadEnv } from '../src/config/env.ts';
import type { smmConfig } from '../src/config/smm.config.ts';
import { createLogger } from '../src/logger.ts';
import { createModel, createModelClient } from '../src/llm/model.ts';
import { judgePost } from '../src/pipeline/review.ts';
import { openStore } from '../src/store/index.ts';

/**
 * Калибровка судьи: как его оценки ложатся на решения владельца.
 *
 * Вопрос ровно один: расходится ли редактор с владельцем. Если посты, которые
 * владелец снял или удалил из канала, судья оценивал НЕ НИЖЕ вышедших, значит
 * пороги в конфиге держат не то, и правит их человек — скрипт только считает.
 *
 * Прогон стоит денег (живая модель) и в CI не ходит.
 */

interface Group {
  readonly name: string;
  readonly means: number[];
}

function summary(group: Group): string {
  if (group.means.length === 0) return `${group.name}: постов нет`;
  const mean = group.means.reduce((sum, value) => sum + value, 0) / group.means.length;
  const sorted = [...group.means].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return `${group.name}: постов ${group.means.length}, средняя ${mean.toFixed(2)}, медиана ${median.toFixed(2)}`;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.logLevel });
  const store = openStore({ path: env.dbPath });
  const model = createModel({ client: createModelClient(env), env, usage: store.usage, logger });

  const published = store.posts.listByStatus(['published', 'posted'], { limit: 50 });
  const buried = store.posts.listByStatus(['withdrawn', 'rejected'], { limit: 50 });
  if (published.length === 0 && buried.length === 0) {
    console.log('В базе нет ни вышедших, ни снятых постов: калибровать нечего.');
    store.close();
    return;
  }

  const groups: Group[] = [
    { name: 'вышли в канал', means: [] },
    { name: 'сняты или удалены', means: [] },
  ];

  for (const [index, batch] of [published, buried].entries()) {
    for (const post of batch) {
      const body = post.body ?? '';
      if (body === '') continue;
      const verdict = await judgePost(
        body,
        {
          platform: post.platform,
          rubric: (post.rubric ?? 'news') as keyof typeof smmConfig.rubrics,
          layout: post.layout ?? 'a',
          cta: post.cta,
          hasImage: post.imagePath !== undefined,
        },
        { model, logger },
      );
      if (!verdict.ok) {
        console.log(`пропущен ${post.id}: ${verdict.message}`);
        continue;
      }
      groups[index]?.means.push(verdict.value.mean);
    }
  }

  for (const group of groups) console.log(summary(group));

  const [out, dead] = groups;
  if (out !== undefined && dead !== undefined && out.means.length > 0 && dead.means.length > 0) {
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    const gap = mean(out.means) - mean(dead.means);
    console.log(
      gap > 0.3
        ? `Судья и владелец согласны: вышедшие выше снятых на ${gap.toFixed(2)}.`
        : `⚠️ Судья хвалит не то: разрыв ${gap.toFixed(2)}. Пороги в конфиге стоит пересмотреть.`,
    );
  }

  const spend = store.usage.sumByMonth(new Date().toISOString().slice(0, 7));
  console.log(`расход за месяц после прогона: $${(spend.usdMicros / 1_000_000).toFixed(4)}`);
  store.close();
}

await main();
