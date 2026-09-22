import { smmConfig, type LayoutKey, type SmmConfig } from '../config/smm.config.ts';

/**
 * Рендер поста: из тела в markdown получается то, что уйдёт в Telegram.
 *
 * Функция чистая и НЕ знает про grammY: превью и публикация обязаны идти одним
 * кодом (`sendPost`), а тесты разметки не должны поднимать клиент Bot API.
 *
 * Обложку, подпись «Источник» и кнопки добавляет КОД, а не модель: подпись
 * обязана стоять под каждым постом одинаково, а всё, что пишет модель, она
 * рано или поздно напишет иначе (решение владельца 11.09.2026).
 */

export interface RenderButton {
  readonly text: string;
  readonly url: string;
}

export interface RenderKeyboard {
  readonly rows: readonly (readonly RenderButton[])[];
}

export interface RichMedia {
  /** Идентификатор в ссылке `tg://photo?id=`. */
  readonly id: string;
  /** Путь к файлу на диске: его прикрепит отправитель. */
  readonly path: string;
}

export type Outgoing =
  | {
      readonly kind: 'rich';
      readonly markdown: string;
      readonly media: readonly RichMedia[];
      readonly keyboard: RenderKeyboard;
    }
  | {
      readonly kind: 'classic';
      readonly text: string;
      readonly photoPath?: string;
      readonly parseMode: 'HTML';
      readonly keyboard: RenderKeyboard;
    };

export type RenderFailure =
  | 'empty_body'
  | 'image_marker_without_file'
  | 'cover_without_source'
  | 'too_long'
  | 'too_many_blocks';

export type RenderResult =
  | { readonly ok: true; readonly outgoing: Outgoing }
  | { readonly ok: false; readonly reason: RenderFailure; readonly message: string };

/** Что рендер знает о посте. Ровно поля, а не вся строка хранилища. */
export interface RenderablePost {
  readonly layout: LayoutKey;
  readonly body: string;
  readonly sourceUrl?: string;
  readonly imagePath?: string;
  /** Своя кнопка поста: сервис, страница установки. Встаёт НАД кнопкой бота. */
  readonly buttonText?: string;
  readonly buttonUrl?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Клавиатура под постом: своя кнопка поста сверху, кнопка бота снизу.
 *
 * Кнопка бота есть ВСЕГДА и ставит её код: уровень рекламы (`cta`) к ней
 * отношения не имеет — он про текст поста. В подписи имя бота не дублируется,
 * кнопка заметнее и не требует ничего копировать.
 */
export function buildKeyboard(post: RenderablePost, config: SmmConfig = smmConfig): RenderKeyboard {
  const rows: RenderButton[][] = [];
  const text = post.buttonText?.trim() ?? '';
  const url = post.buttonUrl?.trim() ?? '';
  if (text !== '' && /^https?:\/\//i.test(url)) {
    rows.push([{ text: text.slice(0, 64), url }]);
  }
  rows.push([{ text: config.buttons.bot.text.slice(0, 64), url: config.buttons.bot.url }]);
  return { rows };
}

/** Тело с обложкой на месте и подписью «Источник» в конце. */
function buildRichMarkdown(post: RenderablePost, config: SmmConfig): string {
  const marker = config.markers.image;
  let body = post.body.trim();

  if (post.imagePath !== undefined) {
    body = body.includes(marker)
      ? // Маркер перекрывает правило: снимок встаёт туда, где он доказывает
        // утверждение — шаг инструкции, экран с ценой.
        body.split(marker).join(config.markers.coverRef)
      : `${config.markers.coverRef}\n\n${body}`;
  } else {
    body = body.split(marker).join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (post.sourceUrl !== undefined && post.sourceUrl !== '') {
    // Ссылки на сам канал в подписи НЕТ намеренно: пост читают из канала.
    body += `\n\n<footer><a href="${escapeHtml(post.sourceUrl)}">Источник</a></footer>`;
  }
  return `${body}\n`;
}

/**
 * Оценка числа блоков rich-сообщения: у Telegram потолок 500 вместе с
 * вложенными. Считаем по разметке — точное дерево строит сервер, но порядок
 * величины нам и нужен, чтобы не отправлять заведомо негодное.
 */
function estimateBlocks(markdown: string): number {
  const lines = markdown.split('\n').filter((line) => line.trim() !== '');
  const tableRows = lines.filter((line) => line.trim().startsWith('|')).length;
  const listItems = lines.filter((line) => /^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(line)).length;
  const paragraphs = lines.length - tableRows - listItems;
  return paragraphs + tableRows + listItems;
}

/** Markdown тела в HTML для обычного сообщения (раскладка А). */
export function toTelegramHtml(body: string, sourceUrl?: string): string {
  const lines = body.trim().split('\n');
  const out: string[] = [];
  let inQuote = false;

  const closeQuote = (): void => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s{0,3}>\s?/.test(line)) {
      if (!inQuote) {
        out.push('<blockquote expandable>');
        inQuote = true;
      }
      out.push(inline(line.replace(/^\s{0,3}>\s?/, '')));
      continue;
    }
    closeQuote();
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(`<b>${inline(heading[2] ?? '')}</b>`);
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      out.push(`• ${inline(bullet[1] ?? '')}`);
      continue;
    }
    out.push(inline(line));
  }
  closeQuote();

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (sourceUrl !== undefined && sourceUrl !== '') {
    text += `\n\n<a href="${escapeHtml(sourceUrl)}">Источник</a>`;
  }
  return text;
}

/** Инлайн-разметка: экранирование идёт ПЕРВЫМ, теги ставятся после. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, href: string) => {
      return `<a href="${href}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

export function renderPost(post: RenderablePost, config: SmmConfig = smmConfig): RenderResult {
  const body = post.body.trim();
  if (body === '') return { ok: false, reason: 'empty_body', message: 'тело поста пустое' };

  if (body.includes(config.markers.image) && post.imagePath === undefined) {
    return {
      ok: false,
      reason: 'image_marker_without_file',
      message: `в теле стоит ${config.markers.image}, а картинки у поста нет`,
    };
  }
  if (post.imagePath !== undefined && (post.sourceUrl === undefined || post.sourceUrl === '')) {
    // Обложка приходит из статьи-первоисточника. Публиковать её без ссылки —
    // значит брать чужую картинку без указания, откуда она.
    return {
      ok: false,
      reason: 'cover_without_source',
      message: 'у поста есть обложка, но нет ссылки на источник',
    };
  }

  const keyboard = buildKeyboard(post, config);
  const layout = config.layouts[post.layout];

  if (layout.format === 'rich') {
    const markdown = buildRichMarkdown(post, config);
    if (markdown.length > config.formats.rich.charsMax) {
      return {
        ok: false,
        reason: 'too_long',
        message: `rich-сообщение ${markdown.length} знаков, потолок ${config.formats.rich.charsMax}`,
      };
    }
    const blocks = estimateBlocks(markdown);
    if (blocks > config.formats.rich.blocksMax) {
      return {
        ok: false,
        reason: 'too_many_blocks',
        message: `блоков около ${blocks}, потолок ${config.formats.rich.blocksMax}`,
      };
    }
    const media: RichMedia[] =
      post.imagePath === undefined
        ? []
        : [{ id: config.markers.coverId, path: post.imagePath }];
    return { ok: true, outgoing: { kind: 'rich', markdown, media, keyboard } };
  }

  // Раскладка А уходит обычным сообщением: её обязаны видеть Telegram Web и
  // витрина t.me/s, которые rich-сообщения не рендерят вовсе.
  const text = toTelegramHtml(body.split(config.markers.image).join('').trim(), post.sourceUrl);
  const limit =
    post.imagePath === undefined ? config.formats.classic.textMax : config.formats.classic.captionMax;
  if (text.length > limit) {
    return {
      ok: false,
      reason: 'too_long',
      message:
        post.imagePath === undefined
          ? `текст ${text.length} знаков, потолок сообщения ${limit}`
          : `подпись к фото ${text.length} знаков, потолок ${limit}`,
    };
  }
  return {
    ok: true,
    outgoing: {
      kind: 'classic',
      text,
      parseMode: 'HTML',
      keyboard,
      ...(post.imagePath === undefined ? {} : { photoPath: post.imagePath }),
    },
  };
}
