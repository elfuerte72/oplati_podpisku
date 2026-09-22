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

function textOf(block: string): string {
  const match = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
  return decodeEntities((match?.[1] ?? '').replace(/<[^>]+>/g, ' '));
}

function linksOf(block: string): string[] {
  const text = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
  const out: string[] = [];
  for (const match of text.matchAll(/<a[^>]+href="([^"]+)"/gi)) {
    const href = decodeEntities(match[1] ?? '');
    if (href.startsWith('http')) out.push(href);
  }
  return out;
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
  for (const block of messageBlocks(page.text).slice(-(options.limit ?? 20))) {
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
    items.push({
      sourceKind: 'telegram',
      sourceRef: clean,
      url: source,
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return { ok: true, items };
}
