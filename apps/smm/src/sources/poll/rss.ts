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
  const value = decodeEntities(
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim(),
  );
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

export async function rssFeed(url: string, options: HttpOptions = {}): Promise<PollResult> {
  const page = await fetchText(url, options);
  if (!page.ok) return { ok: false, reason: page.reason, message: page.message };

  const items: Item[] = [];
  for (const block of blocks(page.text)) {
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
