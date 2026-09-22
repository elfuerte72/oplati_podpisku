import { decodeEntities } from '../html.ts';
import { fetchText, type HttpOptions } from '../http.ts';
import type { Item, PollResult } from './types.ts';

/**
 * Витрина канала `t.me/s/<канал>`: публичная HTML-страница с последними
 * постами. Бесплатно и без аккаунта — Bot API чужие каналы не читает, а
 * MTProto с юзер-сессией грозит баном аккаунта (ресерч 22.09.2026).
 *
 * ⚠️ Наружу отдаётся ТОЛЬКО адрес первоисточника из поста. Текст чужого поста
 * не возвращается и нигде не сохраняется: канал пересказывает первоисточник,
 * а не чужие посты, и копия чужого текста в нашей базе не нужна никому.
 */

/** Приметы рекламного поста: по любой из них пост пропускается целиком. */
const AD_MARKERS = [
  /\berid\b/i,
  /utm_source=tg[_-]/i,
  /(?<![а-яё])реклам[аыу](?![а-яё])/i,
  /(?<![а-яё])промокод(?![а-яё])/i,
  /(?<![а-яё])партнёрск/i,
];

/** Ссылки, которые первоисточником не являются. */
const NOT_A_SOURCE = /^https?:\/\/(t\.me|telegram\.me|telegra\.ph|telesco\.pe)\//i;

function messageBlocks(html: string): string[] {
  // Витрина отдаёт посты одинаковыми блоками; разбираем по началу блока, а не
  // по закрывающему тегу: вложенных div внутри поста произвольное число.
  return html.split(/<div class="tgme_widget_message[ "]/).slice(1);
}

/**
 * Разметка СВОЕГО текста поста.
 *
 * ⚠️ Берётся `js-message_text`, а не первый попавшийся `..._message_text`: у
 * поста-ответа первым идёт цитата (`js-message_reply_text`), и парсер по
 * первому совпадению читал чужой пост вместо нашего — вместе с его ссылками и
 * без меток рекламы, которые стоят в собственном тексте (ревью 22.09.2026,
 * живые `meduzalive` и `tginfo`).
 */
function ownTextHtml(block: string): string {
  const opening = /<div class="[^"]*\bjs-message_text\b[^"]*"[^>]*>/.exec(block);
  if (opening === null) return '';
  const start = opening.index + opening[0].length;

  // Внутри текста поста бывают вложенные `div` (опросы, цитаты, спойлеры):
  // режем по ПАРНОМУ закрывающему тегу, а не по первому встречному.
  let depth = 1;
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  for (let match = tags.exec(block); match !== null; match = tags.exec(block)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return block.slice(start, match.index);
  }
  return block.slice(start);
}

function textOf(block: string): string {
  return decodeEntities(ownTextHtml(block).replace(/<[^>]+>/g, ' '));
}

function linksOf(block: string): string[] {
  const text = ownTextHtml(block);
  const out: string[] = [];
  for (const match of text.matchAll(/<a[^>]+href="([^"]+)"/gi)) {
    const href = decodeEntities(match[1] ?? '');
    if (href.startsWith('http')) out.push(href);
  }
  return out;
}

/** Просмотры поста: единственный доступный счётчик охвата у чужого канала. */
function viewsOf(block: string): number | undefined {
  const raw = /<span class="tgme_widget_message_views">([^<]+)<\/span>/.exec(block)?.[1];
  if (raw === undefined) return undefined;
  const match = /^([\d.,]+)\s*([KMКМ])?$/i.exec(raw.trim());
  if (match === null) return undefined;
  const value = Number((match[1] ?? '').replace(',', '.'));
  if (!Number.isFinite(value)) return undefined;
  const suffix = (match[2] ?? '').toUpperCase();
  const factor = suffix === 'K' || suffix === 'К' ? 1000 : suffix === 'M' || suffix === 'М' ? 1_000_000 : 1;
  return Math.round(value * factor);
}

function publishedAtOf(block: string): string | undefined {
  const raw = /<time[^>]+datetime="([^"]+)"/.exec(block)?.[1];
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export interface TelegramWidgetOptions extends HttpOptions {
  /** Сколько последних постов разбирать. Витрина отдаёт около двадцати. */
  readonly limit?: number;
}

export async function telegramWidget(
  channel: string,
  options: TelegramWidgetOptions = {},
): Promise<PollResult> {
  const clean = channel.replace(/^@/, '').trim();
  if (clean === '') return { ok: false, reason: 'bad_channel', message: 'пустое имя канала' };

  const page = await fetchText(`https://t.me/s/${clean}`, options);
  if (!page.ok) return { ok: false, reason: page.reason, message: page.message };

  const items: Item[] = [];
  const seen = new Set<string>();
  const limit = options.limit ?? 20;
  // ⚠️ `slice(-0)` — это весь массив, а не пустой: нулевой потолок нужно
  // обрабатывать явно.
  const blocks = limit <= 0 ? [] : messageBlocks(page.text).slice(-limit);
  for (const block of blocks) {
    const text = textOf(block);
    const links = linksOf(block);
    const haystack = `${text} ${links.join(' ')}`;
    if (AD_MARKERS.some((marker) => marker.test(haystack))) continue;

    const source = links.find((link) => !NOT_A_SOURCE.test(link));
    // Пост без ссылки наружу — это мысли автора канала, а не материал:
    // пересказывать его нам нечего.
    if (source === undefined || seen.has(source)) continue;
    seen.add(source);

    const publishedAt = publishedAtOf(block);
    const views = viewsOf(block);
    items.push({
      sourceKind: 'telegram',
      sourceRef: clean,
      url: source,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(views === undefined ? {} : { views }),
    });
  }
  return { ok: true, items };
}
