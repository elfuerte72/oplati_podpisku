import { decodeEntities } from '../html.ts';
import { fetchText, type HttpOptions } from '../http.ts';
import type { Item, PollResult } from './types.ts';

/**
 * Лента RSS или Atom. Свой разбор, без зависимостей: нужны ровно три поля —
 * заголовок, ссылка и дата, а полноценный парсер XML тянет пакет ради них.
 */

function blocks(xml: string): string[] {
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((match) => match[0]);
  if (items.length > 0) return items;
  return [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function tagText(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (match?.[1] === undefined) return undefined;
  // ⚠️ Теги снимаются ДО НЕПОДВИЖНОСТИ: один проход обманывается вложенной
  // формой (`<<b>b>` превращается в `<b>`), а заголовок ленты уезжает и в
  // промпт ранжирования, и в сообщение владельцу.
  let stripped = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let pass = 0; pass < 5; pass += 1) {
    const next = stripped.replace(/<[^>]+>/g, '');
    if (next === stripped) break;
    stripped = next;
  }
  const value = decodeEntities(stripped.trim());
  return value === '' ? undefined : value;
}

function linkOf(block: string): string | undefined {
  // RSS кладёт адрес в текст тега, Atom — в атрибут `href`. Встречается и то,
  // и другое в одной ленте, поэтому пробуем оба.
  const text = tagText(block, 'link');
  if (text !== undefined && text.startsWith('http')) return text;
  const attribute =
    /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i.exec(block)?.[1] ??
    /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1];
  return attribute === undefined ? undefined : decodeEntities(attribute);
}

function dateOf(block: string): string | undefined {
  const raw =
    tagText(block, 'pubDate') ?? tagText(block, 'updated') ?? tagText(block, 'published');
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export interface RssOptions extends HttpOptions {
  /**
   * Сколько элементов брать. ⚠️ Потолок обязателен: живой `openai.com/news/rss.xml`
   * отдаёт больше шестисот записей за вызов, и без отсечки один прогон резал
   * бы их на три десятка ПЛАТНЫХ пачек ранжирования.
   */
  readonly limit?: number;
}

export async function rssFeed(url: string, options: RssOptions = {}): Promise<PollResult> {
  const page = await fetchText(url, options);
  if (!page.ok) return { ok: false, reason: page.reason, message: page.message };

  const items: Item[] = [];
  const limit = options.limit ?? 20;
  for (const block of blocks(page.text).slice(0, Math.max(0, limit))) {
    const link = linkOf(block);
    if (link === undefined || !link.startsWith('http')) continue;
    const title = tagText(block, 'title');
    const publishedAt = dateOf(block);
    items.push({
      sourceKind: 'rss',
      sourceRef: url,
      url: link,
      ...(title === undefined ? {} : { title }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return { ok: true, items };
}
