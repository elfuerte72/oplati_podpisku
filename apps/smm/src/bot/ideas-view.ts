import { smmConfig, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { buildCallback } from '../dialog/callback.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { Keyboard } from '../dialog/types.ts';
import type { RankItem } from '../llm/schemas.ts';
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

function rankOf(item: Item): Partial<RankItem> {
  return (item.rank ?? {}) as Partial<RankItem>;
}

/** Оценка для сортировки: неоценённое идёт ниже оценённого, но не пропадает. */
function scoreOf(item: Item): number {
  const rank = rankOf(item);
  if (rank.already_covered === true) return -1;
  return rank.relevance ?? 0;
}

export function ideaItems(
  store: Store,
  options: { config?: SmmConfig; now?: () => Date } = {},
): IdeaLine[] {
  const config = options.config ?? smmConfig;
  const now = options.now ?? ((): Date => new Date());
  const since = new Date(now().getTime() - config.sources.digestWindowHours * 60 * 60 * 1000);

  return store.items
    .listRecent({ sinceIso: since.toISOString(), limit: 200, onlyUnjudged: true })
    .filter((item) => rankOf(item).already_covered !== true)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, config.sources.digestTopN)
    .map((item) => {
      const rank = rankOf(item);
      const rubric = rank.rubric === undefined ? undefined : config.rubrics[rank.rubric as RubricKey];
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
