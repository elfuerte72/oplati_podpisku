import { z } from 'zod';

import { RUBRIC_KEYS, smmConfig, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { buildCallback } from '../dialog/callback.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { Keyboard } from '../dialog/types.ts';
import type { Store } from '../store/index.ts';
import type { Item } from '../store/types.ts';

/**
 * `/ideas` — дайджест тем из источников: что принесли каналы, RSS, HN, X,
 * Threads и Reddit за окно, отсортированное по оценке.
 *
 * Наружу идёт заголовок и адрес первоисточника — текста чужого поста у нас
 * нет и не было (см. `sources/poll/types.ts`).
 */

export interface IdeaLine {
  readonly item: Item;
  readonly line: string;
  readonly keyboard: Keyboard;
}

/**
 * Оценка идеи из колонки JSON. Разбирается схемой, а не приведением: строку
 * пишет наш код, но правка базы руками — обычное дело, и негодная оценка не
 * должна ронять дайджест.
 */
const StoredRank = z
  .object({
    rubric: z.enum(RUBRIC_KEYS).optional(),
    relevance: z.number().int().min(1).max(5).optional(),
    reader_action: z.boolean().optional(),
    already_covered: z.boolean().optional(),
    why: z.string().optional(),
  })
  .partial();

function rankOf(item: Item): z.infer<typeof StoredRank> {
  const parsed = StoredRank.safeParse(item.rank ?? {});
  return parsed.success ? parsed.data : {};
}

/** Оценка для сортировки: неоценённое идёт ниже оценённого, но не пропадает. */
function scoreOf(item: Item): number {
  const rank = rankOf(item);
  if (rank.already_covered === true) return -1;
  return rank.relevance ?? 0;
}

export interface RankedIdea {
  readonly item: Item;
  /** Оценка ранжирования 1–5; неоценённая идея — `undefined`. */
  readonly relevance?: number;
  readonly rubric?: RubricKey;
}

/**
 * Идеи в порядке, в каком их стоит писать. ОДНА сортировка на `/ideas` и на
 * черновики по расписанию: разные порядки означали бы, что бот пишет не ту
 * тему, что стоит первой в дайджесте. Идеи, уже взятые в работу (черновик по
 * расписанию или «Написать»), сюда не попадают: по ним пост уже пишется.
 */
export function rankedIdeas(
  store: Store,
  options: { config?: SmmConfig; now?: () => Date } = {},
): RankedIdea[] {
  const config = options.config ?? smmConfig;
  const now = options.now ?? ((): Date => new Date());
  const since = new Date(now().getTime() - config.sources.digestWindowHours * 60 * 60 * 1000);

  return store.items
    .listRecent({ sinceIso: since.toISOString(), limit: 200, onlyUnjudged: true, onlyNotTaken: true })
    .filter((item) => rankOf(item).already_covered !== true)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((item) => {
      const rank = rankOf(item);
      return {
        item,
        ...(rank.relevance === undefined ? {} : { relevance: rank.relevance }),
        ...(rank.rubric === undefined ? {} : { rubric: rank.rubric }),
      };
    });
}

export function ideaItems(
  store: Store,
  options: { config?: SmmConfig; now?: () => Date } = {},
): IdeaLine[] {
  const config = options.config ?? smmConfig;
  return rankedIdeas(store, options)
    .slice(0, config.sources.digestTopN)
    .map(({ item }) => {
      const rank = rankOf(item);
      const rubric = rank.rubric === undefined ? undefined : config.rubrics[rank.rubric];
      const parts = [
        item.title ?? item.url,
        [
          item.sourceRef === undefined ? item.sourceKind : `${item.sourceKind}/${item.sourceRef}`,
          rubric === undefined ? undefined : rubric.title,
          rank.relevance === undefined ? undefined : `оценка ${rank.relevance}`,
        ]
          .filter((part) => part !== undefined)
          .join(' · '),
        rank.why ?? '',
        item.url,
      ].filter((part) => part !== '');
      return {
        item,
        line: parts.join('\n'),
        keyboard: {
          rows: [
            [
              { text: TEXTS.buttons.writeIt, data: buildCallback('i.write', item.id, 'idea') },
              { text: TEXTS.buttons.skip, data: buildCallback('i.skip', item.id, 'idea') },
            ],
            [{ text: TEXTS.buttons.offtopic, data: buildCallback('i.off', item.id, 'idea') }],
          ],
        },
      };
    });
}

export function ideasEmptyText(): string {
  return 'Новых тем нет. Загляну в источники в следующий прогон.';
}
