/**
 * Разбор текста поста: что считается видимым текстом, абзацем, числом, блоком.
 *
 * Все функции чистые и без часов: линт обязан быть детерминированным — один
 * вход, один вывод. Свежесть получает историю аргументом, а не читает базу.
 */

export const IMAGE_MARKER = '[[IMAGE]]';

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const HTML_TAG_RE = /<[^>]+>/g;

/**
 * Текст без разметки: длину и запреты считаем по тому, что видит читатель.
 * Иначе теги футера и адрес ссылки идут в зачёт длины, а `**жирный**` ломает
 * счёт знаков ровно на четыре символа в каждом акценте.
 */
export function visibleText(raw: string): string {
  let text = raw.replace(MD_IMAGE_RE, '');
  text = text.replace(MD_LINK_RE, '$1');
  text = text.replace(HTML_TAG_RE, '');
  text = text.split(IMAGE_MARKER).join('');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}-{3,}\s*$/gm, '');
  text = text.replace(/^\s*```[a-z]*\s*$/gm, '');
  text = text.replace(/^\s*\|[\s|:-]+\|\s*$/gm, '');
  text = text.split('**').join('').split('==').join('');
  text = text.replace(/(?<!\*)\*(?!\*)/g, '');
  return text.trim();
}

/** Заголовок первого уровня, если он есть. */
export function headline(raw: string): string {
  const body = raw.replace(MD_IMAGE_RE, '');
  for (const match of body.matchAll(/^\s{0,3}(#{1,6})\s+(.+)$/gm)) {
    if (match[1]?.length === 1) return (match[2] ?? '').trim();
  }
  return '';
}

/** Первые два слова строки: по ним ловится повтор зачина из прошлых постов. */
export function opener(text: string): string {
  const words = text.toLowerCase().match(/[а-яёa-z0-9]+/g) ?? [];
  return words.slice(0, 2).join(' ');
}

export interface Headings {
  readonly h1: readonly string[];
  readonly h2: readonly string[];
}

export function headings(raw: string): Headings {
  const body = raw.replace(MD_IMAGE_RE, '');
  const h1: string[] = [];
  const h2: string[] = [];
  for (const match of body.matchAll(/^\s{0,3}(#{1,6})\s+(.+)$/gm)) {
    const level = match[1]?.length ?? 0;
    const text = (match[2] ?? '').trim();
    if (level === 1) h1.push(text);
    else if (level === 2) h2.push(text);
  }
  return { h1, h2 };
}

/** Пункты маркированного списка (сырые строки без маркера). */
export function bullets(raw: string): string[] {
  return [...raw.matchAll(/^\s{0,3}[-*+]\s+(.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

/** Шаги нумерованного списка. */
export function orderedSteps(raw: string): string[] {
  return [...raw.matchAll(/^\s{0,3}\d+[.)]\s+(.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

/** Блоки в тройных обратных апострофах. */
export function codeBlocks(raw: string): string[] {
  return [...raw.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

export interface Table {
  readonly rows: readonly string[];
  readonly columns: number;
}

/**
 * Таблицы GFM. Строка-разделитель (`|---|---|`) в счёт строк не идёт, а шапка
 * идёт: «до пяти строк» в правиле канала — это вместе с шапкой.
 */
export function tables(raw: string): Table[] {
  const lines = raw.split('\n');
  const found: Table[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const dataRows = current.filter((row) => !/^\s*\|[\s|:-]+\|\s*$/.test(row));
    const columns = dataRows.reduce((max, row) => {
      const cells = row.trim().replace(/^\||\|$/g, '').split('|');
      return Math.max(max, cells.length);
    }, 0);
    found.push({ rows: dataRows, columns });
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) current.push(line);
    else flush();
  }
  flush();
  return found;
}

export const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1FB00}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

export function countEmoji(text: string): number {
  return (text.match(EMOJI_RE) ?? []).length;
}

const NUMBER_RE = /\d+(?:[.,:]\d+)*/g;

/**
 * Числительные словами считаются числами: потолок «три числа в абзаце» иначе
 * обходится записью «Пятьсот с лишним» и «три миллиона» — ровно так его и
 * обошли 07.09. «Один/одна/одно» не считаются: это чаще артикль, чем число.
 */
const NUMERAL_WORD_RE = new RegExp(
  '\\b(?:дв(?:а|е|ух|ое|ум|умя|оих)|тр(?:и|ёх|ех|ое|оих|ём|ем)|четыр(?:е|ёх|ех|ём|ем)|' +
    'пят(?:ь|и|ью|еро|ерых)|шест(?:ь|и|ью|еро)|сем(?:ь|и|ью|еро)|восемь|восьм(?:и|ью)|' +
    'девят(?:ь|и|ью)|десят(?:ь|и|ью|ок|ка)|(?:один|две|три|четыр|пят|шест|сем|восем|девят)' +
    'надцат(?:ь|и|ью)|двадцат(?:ь|и|ью)|тридцат(?:ь|и|ью)|сорок[а]?|пятьдесят|пятидесяти|' +
    'шестьдесят|шестидесяти|семьдесят|семидесяти|восемьдесят|восьмидесяти|девяност[оа]|ст[оа]|' +
    'двест[иа]|трист[аи]|четырест[аи]|пятьсот|пятисот|шестьсот|шестисот|семьсот|семисот|' +
    'восемьсот|восьмисот|девятьсот|девятисот|тысяч[аиу]?|миллион[аов]*|миллиард[аов]*|' +
    'полов[а-я]+|четверт[а-я]+|треть[а-я]*)\\b',
  'giu',
);

const NUMBER_UNIT = '(?:млн|млрд|тыс\\.?|%|\\$|₽|€|£)';

/** Сколько чисел в абзаце. «Три миллиона» — одно число, «$20» — одно. */
export function countNumbers(paragraph: string): number {
  const marked = paragraph.replace(NUMERAL_WORD_RE, ' \u0000 ').replace(NUMBER_RE, ' \u0000 ');
  const run = new RegExp('\u0000(?:\\s*(?:\u0000|' + NUMBER_UNIT + '))*', 'gi');
  return (marked.match(run) ?? []).length;
}

/** Строка начинает структурный блок: заголовок, список, цитата, таблица, код. */
const BLOCK_START_RE = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||-{3,}\s*$|```|<)/;

export interface Paragraph {
  readonly text: string;
  readonly visible: string;
  readonly index: number;
  readonly isBlock: boolean;
}

/** Абзацы поста в порядке следования, с пометкой «это структурный блок». */
export function paragraphs(raw: string): Paragraph[] {
  return raw
    .trim()
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== '')
    .map((block, index) => ({
      text: block,
      visible: visibleText(block),
      index: index + 1,
      isBlock: BLOCK_START_RE.test(block),
    }));
}

/** Предложения длиннее порога — по ним ловится дословный повтор. */
export function sentences(visible: string, minChars = 35): Set<string> {
  const parts = visible.toLowerCase().split(/(?<=[.!?])\s+|\n+/);
  const out = new Set<string>();
  for (const part of parts) {
    const clean = part.replace(/\s+/g, ' ').replace(/^[\s.!?«»"]+|[\s.!?«»"]+$/g, '');
    if (clean.length >= minChars) out.add(clean);
  }
  return out;
}

/** Последний эмодзи последней строки: концовка «смайликом» не чаще двух постов подряд. */
export function closingEmoji(visible: string): string {
  const lines = visible.split('\n').filter((line) => line.trim() !== '');
  const last = lines.at(-1) ?? '';
  const found = last.match(EMOJI_RE) ?? [];
  return found.at(-1) ?? '';
}

/** Форма поста: есть ли подзаголовок и список из трёх пунктов. */
export function shape(raw: string): { readonly hasH2: boolean; readonly hasList: boolean } {
  return { hasH2: headings(raw).h2.length > 0, hasList: bullets(raw).length >= 3 };
}
