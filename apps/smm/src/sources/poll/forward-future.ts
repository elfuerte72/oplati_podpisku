import { TRACKING_PARAM, normalizeUrl } from '../../url.ts';
import { decodeEntities, withoutTags } from '../html.ts';
import { fetchText, type HttpOptions } from '../http.ts';
import type { Item, PollResult } from './types.ts';

/**
 * Ежедневная рассылка Forward Future (forwardfuture.com): дайджест новостей ИИ.
 *
 * RSS у сайта нет (проверено 23.09.2026: `/feed`, `/rss`, `/rss.xml` — 404), зато
 * у каждой новости в выпуске стоит ссылка на ПЕРВОИСТОЧНИК (TechCrunch, Axios,
 * блоги компаний). Поэтому единица ленты — не выпуск, а новость внутри него:
 * пост канала пишется про одну тему, а выпуск — это пять тем сразу.
 *
 * ⚠️ Как у витрины Telegram: наружу идёт только адрес первоисточника и заголовок
 * новости. Текст выпуска не возвращается и нигде не сохраняется.
 *
 * Разметка снята с живых страниц 23.09.2026:
 * - архив `/newsletter/daily` перечисляет выпуски от свежих к старым, и
 *   сегодняшний там есть раньше, чем в `sitemaps/newsletter-daily.xml`;
 * - в выпуске новости идут заголовками `h2`/`h3`, ссылка на первоисточник —
 *   `<a class="link">`; подпись раздела — `h5` («HARDWARE», «NEWS»,
 *   «Sponsored · POWERED BY BOX»), других `h4`–`h6` внутри `article` нет.
 */

export const FORWARD_FUTURE_ARCHIVE = 'https://forwardfuture.com/newsletter/daily';

const ORIGIN = 'https://forwardfuture.com';

/**
 * Выпуск весит около 150 КБ, архив — больше 200 КБ. Архиву обрезка не страшна
 * (свежие выпуски в его начале), а выпуск обрезанным терял бы последние новости.
 */
const ISSUE_MAX_BYTES = 1024 * 1024;

/** Свои адреса сайта и платформы рассылки: первоисточником они не бывают. */
const OWN_HOST = /(^|\.)(forwardfuture\.(com|ai)|beehiiv\.com)$/i;

/** Страница канала или профиля — не материал, а реклама автора. */
const NOT_MATERIAL = /^https?:\/\/(www\.)?youtube\.com\/(channel\/|c\/|@)/i;

/**
 * Приметы рекламы: подпись раздела или метка в ссылке. «Powered by» стоит в
 * списке сам по себе: подпись рекламного раздела — «Sponsored · POWERED BY X»,
 * и порядок частей в ней — свойство вёрстки, а не контракт.
 */
const SPONSORED_SECTION = /sponsor|presented by|powered by|partner/i;
const PAID_LINK = /[?&]utm_medium=[^&]*(paid|sponsor)/i;

/** Баннер рекламодателя: картинка «Powered by …» внутри ссылки. */
const SPONSOR_BANNER = /<img\b[^>]*\balt="[^"]*(powered by|presented by|sponsored)/i;

/** Текст ссылки, который заголовком новости не является. */
const GENERIC_ANCHOR = /^(→\s*)?(read (the )?(full )?(article|story|more)( here)?|here|link|source)\.?$/i;

export interface Issue {
  readonly url: string;
  /** Дата выпуска из адреса, `YYYY-MM-DD`. */
  readonly date: string;
}

/** Свежие выпуски из архива: новые первыми, без повторов. */
export function archiveIssues(html: string, limit: number): Issue[] {
  const byPath = new Map<string, Issue>();
  for (const match of html.matchAll(/href="(\/newsletter\/daily\/(\d{4}-\d{2}-\d{2})\/[a-z0-9-]+)"/gi)) {
    const path = match[1];
    const date = match[2];
    if (path === undefined || date === undefined || byPath.has(path)) continue;
    byPath.set(path, { url: `${ORIGIN}${path}`, date });
  }
  // Порядок в разметке — свойство вёрстки, а не контракт: сортируем сами.
  return [...byPath.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(0, limit));
}

function plainText(html: string): string {
  return withoutTags(html, ' ').replace(/\s+/g, ' ').trim();
}

/** Адрес первоисточника без меток рассылки, или `undefined`, если это не он. */
function sourceUrl(rawHref: string): string | undefined {
  const raw = decodeEntities(rawHref);
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (OWN_HOST.test(url.hostname)) return undefined;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  const clean = url.toString();
  return NOT_MATERIAL.test(clean) ? undefined : clean;
}

function hrefOf(attributes: string): string | undefined {
  return /\bhref="([^"]+)"/i.exec(attributes)?.[1];
}

/** Редакционная ссылка выпуска: у новостей и оглавления класс `link`. */
function isEditorialLink(attributes: string): boolean {
  return /\bclass="[^"]*\blink\b[^"]*"/i.test(attributes);
}

export interface Story {
  readonly url: string;
  readonly title: string;
}

/**
 * Новости выпуска: заголовок и адрес первоисточника.
 *
 * Идём по разметке ПОДРЯД: подпись раздела, заголовок новости, ссылка. Так
 * ссылка «→ Read the full article here» получает заголовок новости над ней.
 *
 * ⚠️ Реклама отсекается по АДРЕСУ, а не по месту: рекламодатель выпуска стоит
 * ещё и баннером в самом начале, до первого раздела, и под баннером — обычная
 * ссылка класса `link` («Shop the Pod»). Место её не выдаёт, а адрес тот же,
 * что в разделе «Sponsored» ниже и за картинкой «Powered by …». Поэтому адрес,
 * хоть раз замеченный рекламным, выпадает из выпуска целиком (живые выпуски
 * 22.09 и 23.09.2026: Box и Eight Sleep). Сравнение — по `normalizeUrl`:
 * баннер и раздел могут отличаться `www.` и косой чертой в конце.
 */
export function issueStories(html: string): Story[] {
  const start = html.search(/<article\b/i);
  const end = html.lastIndexOf('</article>');
  // Всё, что вне `article`, — меню, «More briefings» и комментарии.
  const body = start >= 0 && end > start ? html.slice(start, end) : html;

  const tokens =
    /<(h[4-6])\b[^>]*>([\s\S]*?)<\/\1>|<(h[23])\b[^>]*>([\s\S]*?)<\/\3>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  const stories: Story[] = [];
  const byKey = new Map<string, number>();
  const sponsored = new Set<string>();
  let sponsoredSection = false;
  let heading = '';
  // Ссылку вёрстка иногда рвёт на два `a` с одним адресом подряд («Samsung
  // Backs Kairos» + «Reactor»). Склеиваем ТОЛЬКО соседние куски: между двумя
  // ссылками на один адрес с текстом посередине («Apple…» reports «Axios»)
  // стоят разные подписи, и склейка испортила бы заголовок.
  let previous: { key: string; end: number } | undefined;

  const add = (href: string, title: string, attributes: string, inner: string, at: { start: number; end: number }): void => {
    const url = sourceUrl(href);
    const adjacent =
      previous !== undefined && plainText(body.slice(previous.end, at.start)) === '' ? previous : undefined;
    previous = undefined;
    if (url === undefined) return;
    const key = normalizeUrl(url);
    // Метку в адресе проверяем ПОСЛЕ раскодирования: в разметке `&amp;utm_medium=`,
    // и перед меткой стоит `;`, а не `&`.
    if (sponsoredSection || PAID_LINK.test(decodeEntities(href)) || SPONSOR_BANNER.test(inner)) {
      sponsored.add(key);
    }
    if (!isEditorialLink(attributes) || title === '') return;

    const index = byKey.get(key);
    if (index !== undefined) {
      const earlier = stories[index];
      if (adjacent?.key === key && earlier !== undefined && !earlier.title.endsWith(title)) {
        stories[index] = { url: earlier.url, title: `${earlier.title} ${title}`.slice(0, 200) };
      }
    } else {
      byKey.set(key, stories.length);
      stories.push({ url, title: title.slice(0, 200) });
    }
    previous = { key, end: at.end };
  };

  for (const match of body.matchAll(tokens)) {
    const [whole, , sectionHtml, headingTag, headingHtml, anchorAttributes, anchorHtml] = match;
    const at = { start: match.index, end: match.index + whole.length };
    if (sectionHtml !== undefined) {
      // Новый раздел — новый контекст: заголовок прошлой новости к ссылкам
      // этого раздела отношения не имеет.
      sponsoredSection = SPONSORED_SECTION.test(plainText(sectionHtml));
      heading = '';
      previous = undefined;
      continue;
    }
    if (headingTag !== undefined && headingHtml !== undefined) {
      heading = plainText(headingHtml);
      previous = undefined;
      // Оглавление выпуска — это `h3` со ссылкой ВНУТРИ: заголовок и адрес сразу.
      const inner = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(headingHtml);
      const href = inner?.[1] === undefined ? undefined : hrefOf(inner[1]);
      if (inner?.[1] !== undefined && href !== undefined) add(href, heading, inner[1], inner[2] ?? '', at);
      previous = undefined;
      continue;
    }
    if (anchorAttributes !== undefined) {
      const href = hrefOf(anchorAttributes);
      if (href === undefined) {
        previous = undefined;
        continue;
      }
      const text = plainText(anchorHtml ?? '');
      const title = text === '' || GENERIC_ANCHOR.test(text) ? heading : text;
      add(href, title, anchorAttributes, anchorHtml ?? '', at);
    }
  }
  return stories.filter((story) => !sponsored.has(normalizeUrl(story.url)));
}

export interface ForwardFutureOptions extends HttpOptions {
  /** Сколько последних выпусков разбирать. Рассылка выходит по будням. */
  readonly issues?: number;
}

export async function forwardFuture(options: ForwardFutureOptions = {}): Promise<PollResult> {
  const archive = await fetchText(FORWARD_FUTURE_ARCHIVE, options);
  if (!archive.ok) return { ok: false, reason: archive.reason, message: archive.message };

  const issues = archiveIssues(archive.text, options.issues ?? 2);
  if (issues.length === 0) {
    // Архив открылся, а выпусков в нём нет — это сменившаяся вёрстка, а не
    // тихий день: молча отдавать пустую ленту значило бы потерять источник.
    return { ok: false, reason: 'contract', message: 'в архиве Forward Future не нашлось ни одного выпуска' };
  }

  // Выпуски независимы: последовательно медленный сайт держал бы весь прогон
  // источников до трёх сроков запроса подряд.
  const pages = await Promise.all(
    issues.map(async (issue) => ({ issue, page: await fetchText(issue.url, { ...options, maxBytes: ISSUE_MAX_BYTES }) })),
  );

  const items: Item[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  // Свежий выпуск первым: новость из двух выпусков подписывается свежим.
  for (const { issue, page } of pages) {
    if (!page.ok) {
      warnings.push(`${issue.date}: ${page.reason}`);
      continue;
    }
    const stories = issueStories(page.text);
    if (stories.length === 0) warnings.push(`${issue.date}: нет ни одной новости со ссылкой`);
    for (const story of stories) {
      const key = normalizeUrl(story.url);
      if (seen.has(key)) continue;
      seen.add(key);
      // ⚠️ `publishedAt` НЕ ставится: дата выпуска — не дата статьи, а хранилище
      // обновляет `published_at` при каждом повторе адреса и затирало бы точное
      // время той же статьи из RSS или канала.
      items.push({ sourceKind: 'forwardfuture', sourceRef: issue.date, url: story.url, title: story.title });
    }
  }

  if (items.length === 0) {
    return { ok: false, reason: 'contract', message: `выпуски не разобрались: ${warnings.join('; ')}` };
  }
  return { ok: true, items, ...(warnings.length === 0 ? {} : { warnings }) };
}
