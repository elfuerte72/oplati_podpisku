import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { RankSchema, type RankItem } from '../llm/schemas.ts';
import type { Item } from '../sources/poll/types.ts';
import { normalizeUrl } from '../url.ts';
import { rankInput } from './inputs.ts';
import { logStepDone, logStepFailed, logStepStarted } from './steps.ts';
import type { PipelineDeps } from './types.ts';

/**
 * Оценка идей из источников: что из этого стоит поста.
 *
 * Пачками, потому что элементов за прогон десятки, а роль отвечает JSON'ом:
 * одна пачка на 20 элементов — компромисс между числом вызовов и риском, что
 * модель обрежет длинный ответ.
 */

/** Сколько элементов в одном вызове. Больше — выше риск обрезанного ответа. */
export const RANK_BATCH = 20;

export interface RankContext {
  /** Заголовки и адреса наших постов за окно (обычно 60 дней). */
  readonly published?: readonly { title: string; url?: string }[];
  /** Темы, отмеченные владельцем как «не по теме». */
  readonly offtopic?: readonly string[];
  readonly config?: SmmConfig;
}

export interface RankedItem {
  readonly item: Item;
  readonly rank: RankItem;
}

/**
 * Совпадение с уже опубликованным — ДО модели и без неё: адрес мы знаем
 * точно, а платить за подтверждение того, что и так видно, незачем.
 */
export function coveredByUrl(item: Item, published: readonly { url?: string }[]): boolean {
  const mine = normalizeUrl(item.url);
  return published.some((post) => post.url !== undefined && normalizeUrl(post.url) === mine);
}

export async function rankItems(
  items: readonly Item[],
  ctx: RankContext,
  deps: PipelineDeps,
): Promise<RankedItem[]> {
  const config = ctx.config ?? deps.config ?? smmConfig;
  const published = ctx.published ?? [];
  const out: RankedItem[] = [];

  const pending: Item[] = [];
  for (const item of items) {
    if (coveredByUrl(item, published)) {
      // Код уверен: этот адрес уже был. Модели тут делать нечего.
      out.push({
        item,
        rank: {
          url: item.url,
          relevance: 1,
          reader_action: false,
          already_covered: true,
          why: 'этот адрес уже был в канале',
        },
      });
      continue;
    }
    pending.push(item);
  }

  for (let start = 0; start < pending.length; start += RANK_BATCH) {
    const batch = pending.slice(start, start + RANK_BATCH);
    const logCtx = { step: 'rank' };
    logStepStarted(deps, logCtx);
    const at = Date.now();
    const answer = await deps.model.json(
      'rank',
      rankInput({
        items: batch,
        published,
        ...(ctx.offtopic === undefined ? {} : { offtopic: ctx.offtopic }),
        config,
      }),
      RankSchema,
    );
    if (!answer.ok) {
      // Пачка не оценилась — остальные всё равно оцениваем: половина ленты
      // лучше, чем ничего, а причина уже в логе.
      logStepFailed(deps, logCtx, answer.reason, Date.now() - at);
      continue;
    }
    logStepDone(deps, logCtx, Date.now() - at);

    const byUrl = new Map(answer.value.map((row) => [normalizeUrl(row.url), row]));
    for (const item of batch) {
      const rank = byUrl.get(normalizeUrl(item.url));
      // Элемент, который модель пропустила, тихо теряться не должен: он
      // остаётся неоценённым и попадёт в следующий прогон.
      if (rank === undefined) continue;
      out.push({ item, rank });
    }
  }

  return out;
}
