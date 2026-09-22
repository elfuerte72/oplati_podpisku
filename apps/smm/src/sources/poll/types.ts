/**
 * Элемент ленты источников: ОДНА запись о материале, который стоит рассмотреть.
 *
 * ⚠️ Текста чужого поста здесь нет намеренно. Наружу идёт только адрес
 * первоисточника и заголовок страницы по нему: пересказывать чужой пост — это
 * ровно то, чего канал не делает, и хранить его текст незачем.
 */
export interface Item {
  readonly sourceKind: SourceKind;
  /** Откуда пришло: канал, адрес ленты, аккаунт, сабреддит, запрос. */
  readonly sourceRef?: string;
  /** Адрес ПЕРВОИСТОЧНИКА: по нему идёт дедуп между источниками. */
  readonly url: string;
  readonly title?: string;
  readonly publishedAt?: string;
  /** Просмотры у источника, если он их показывает: витрина Telegram. */
  readonly views?: number;
}

export const SOURCE_KINDS = [
  'telegram',
  'rss',
  'hn',
  'x',
  'threads',
  'reddit',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Исход опроса одного источника. Отказ — не исключение: источник падает
 * регулярно, и один упавший не должен ронять прогон.
 */
export type PollResult =
  | { readonly ok: true; readonly items: readonly Item[]; readonly credits?: number }
  | { readonly ok: false; readonly reason: string; readonly message: string };
