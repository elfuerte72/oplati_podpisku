/**
 * Разбор HTML без зависимостей: боту нужны заголовок, основной текст и
 * обложка, а не полноценный DOM. Зависимость ради этого не заводим — образ
 * бота держит четыре пакета, и парсер страницы в этот список не входит.
 *
 * Функции чистые: на вход строка, на выход данные. Тесты гоняют фикстуры.
 */

const NOISE_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
];

/** Убирает блоки, которые к тексту статьи отношения не имеют. */
export function stripNoise(html: string): string {
  let out = html;
  for (const tag of NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    // Незакрытый тег шума (бывает у header/footer в кривой вёрстке).
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ');
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Неразрывный пробел задан кодом: в исходнике он неотличим от обычного.
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  rsquo: '’',
  lsquo: '‘',
};

/** Раскрывает сущности HTML. Числовые тоже: в русских текстах их много. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Текст без тегов, с сохранением границ абзацев. */
export function toText(html: string): string {
  const withBreaks = html
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** Значение мета-тега по любому из имён (`property` или `name`). */
export function metaContent(html: string, names: readonly string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const key = (
      /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? ''
    ).toLowerCase();
    if (!wanted.has(key)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (content !== undefined && content.trim() !== '') return decodeEntities(content.trim());
  }
  return undefined;
}

/** Содержимое `<link rel="...">`. */
export function linkHref(html: string, rels: readonly string[]): string | undefined {
  const wanted = new Set(rels.map((rel) => rel.toLowerCase()));
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const rel = (/\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '').toLowerCase();
    if (!wanted.has(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (href !== undefined && href.trim() !== '') return decodeEntities(href.trim());
  }
  return undefined;
}

export function documentTitle(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (raw === undefined) return undefined;
  const text = decodeEntities(raw.replace(/\s+/g, ' ')).trim();
  return text === '' ? undefined : text;
}

/**
 * Основной текст статьи: абзацы `<p>` длиннее порога.
 *
 * Это эвристика «самый плотный текст», а не readability целиком: у статей,
 * которые мы читаем, содержание лежит в абзацах, а меню и подвал уже вырезаны
 * `stripNoise`. Короткие абзацы отбрасываются — это подписи и кнопки.
 */
export function mainText(html: string, minParagraph = 60): string {
  const cleaned = stripNoise(html);
  const paragraphs: string[] = [];
  for (const match of cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = toText(match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= minParagraph) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return paragraphs.join('\n\n');
  // Разметка без <p> (бывает у блогов на div-ах): берём текст целиком и
  // оставляем строки, похожие на прозу.
  return toText(cleaned)
    .split('\n')
    .filter((line) => line.length >= minParagraph)
    .join('\n\n');
}
