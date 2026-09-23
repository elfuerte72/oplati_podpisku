import { decodeEntities } from '../html.ts';
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
 *   `<a class="link">`; разделы подписаны `ff-briefing-section-heading`
 *   («HARDWARE», «NEWS»), рекламный — «Sponsored».
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

/** Приметы рекламы: раздел выпуска или метка в ссылке. */
const SPONSORED_SECTION = /sponsor|presented by|partner/i;
const PAID_LINK = /[?&]utm_medium=[^&]*(paid|sponsor)/i;

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
  // ⚠️ Теги снимаются до неподвижности, как в разборе RSS: заголовок уходит и в
  // промпт ранжирования, и в сообщение владельцу.
  let stripped = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = stripped.replace(/<[^>]+>/g, ' ');
    if (next === stripped) break;
    stripped = next;
  }
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** Адрес первоисточника без меток рассылки, или `undefined`, если это не он. */
function sourceUrl(rawHref: string): string | undefined {
  const raw = decodeEntities(rawHref);
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (OWN_HOST.test(url.hostname)) return undefined;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
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

/** Баннер рекламодателя: картинка «Powered by …» внутри ссылки. */
const SPONSOR_BANNER = /<img\b[^>]*\balt="[^"]*(powered by|presented by|sponsored)/i;

export interface Story {
  readonly url: string;
  readonly title: string;
}

/**
 * Новости выпуска: заголовок и адрес первоисточника.
 *
 * Идём по разметке ПОДРЯД: заголовок раздела, заголовок новости, ссылка. Так
 * ссылка «→ Read the full article here» получает заголовок новости над ней.
 *
 * ⚠️ Реклама отсекается по АДРЕСУ, а не по месту: рекламодатель выпуска стоит
 * ещё и баннером в самом начале, до первого раздела, и под баннером — обычная
 * ссылка класса `link` («Shop the Pod»). Место её не выдаёт, а адрес тот же,
 * что в разделе «Sponsored» ниже и за картинкой «Powered by …». Поэтому адрес,
 * хоть раз замеченный рекламным, выпадает из выпуска целиком (живые выпуски
 * 22.09 и 23.09.2026: Box и Eight Sleep).
 */
export function issueStories(html: string): Story[] {
  const start = html.search(/<article\b/i);
  const end = html.lastIndexOf('</article>');
  // Всё, что вне `article`, — меню, «More briefings» и комментарии.
  const body = start >= 0 && end > start ? html.slice(start, end) : html;

  const tokens =
    /class="[^"]*\bff-briefing-section-heading\b[^"]*"[^>]*>([\s\S]*?)<\/|<(h[23])\b[^>]*>([\s\S]*?)<\/\2>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  const stories: Story[] = [];
  const byUrl = new Map<string, number>();
  const sponsored = new Set<string>();
  let section = '';
  let heading = '';
  // Ссылку вёрстка иногда рвёт на два `a` с одним адресом («Samsung Backs
  // Kairos» + «Reactor»): соседние куски склеиваются в один заголовок.
  let previousUrl: string | undefined;

  const add = (href: string, title: string, attributes: string, inner: string): void => {
    const url = sourceUrl(href);
    if (url === undefined) {
      previousUrl = undefined;
      return;
    }
    // Метку в адресе проверяем ПОСЛЕ раскодирования: в разметке `&amp;utm_medium=`,
    // и перед меткой стоит `;`, а не `&`.
    if (SPONSORED_SECTION.test(section) || PAID_LINK.test(decodeEntities(href)) || SPONSOR_BANNER.test(inner)) {
      sponsored.add(url);
    }
    if (!isEditorialLink(attributes) || title === '') {
      previousUrl = undefined;
      return;
    }
    const index = byUrl.get(url);
    if (index !== undefined) {
      const earlier = stories[index];
      if (url === previousUrl && earlier !== undefined && !earlier.title.endsWith(title)) {
        stories[index] = { url, title: `${earlier.title} ${title}`.slice(0, 200) };
      }
      previousUrl = url;
      return;
    }
    byUrl.set(url, stories.length);
    stories.push({ url, title: title.slice(0, 200) });
    previousUrl = url;
  };

  for (const match of body.matchAll(tokens)) {
    const [, sectionHtml, headingTag, headingHtml, anchorAttributes, anchorHtml] = match;
    if (sectionHtml !== undefined) {
      section = plainText(sectionHtml);
      previousUrl = undefined;
      continue;
    }
    if (headingTag !== undefined && headingHtml !== undefined) {
      heading = plainText(headingHtml);
      previousUrl = undefined;
      // Оглавление выпуска — это `h3` со ссылкой ВНУТРИ: заголовок и адрес сразу.
      const inner = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(headingHtml);
      const href = inner?.[1] === undefined ? undefined : hrefOf(inner[1]);
      if (inner?.[1] !== undefined && href !== undefined) add(href, heading, inner[1], inner[2] ?? '');
      continue;
    }
    if (anchorAttributes !== undefined) {
      const href = hrefOf(anchorAttributes);
      if (href === undefined) continue;
      const text = plainText(anchorHtml ?? '');
      const title = text === '' || GENERIC_ANCHOR.test(text) ? heading : text;
      add(href, title, anchorAttributes, anchorHtml ?? '');
    }
  }
  return stories.filter((story) => !sponsored.has(story.url));
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

  const items: Item[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const issue of issues) {
    const page = await fetchText(issue.url, { ...options, maxBytes: ISSUE_MAX_BYTES });
    // Один неоткрывшийся выпуск из двух — не отказ источника: следующий прогон
    // через два часа его доберёт. Отказом он становится, только если не
    // разобрался НИ ОДИН (проверка ниже), и тогда причины уходят в лог.
    if (!page.ok) {
      failures.push(`${issue.date}: ${page.reason}`);
      continue;
    }
    const stories = issueStories(page.text);
    if (stories.length === 0) failures.push(`${issue.date}: нет ни одной новости со ссылкой`);
    for (const story of stories) {
      if (seen.has(story.url)) continue;
      seen.add(story.url);
      items.push({
        sourceKind: 'forwardfuture',
        sourceRef: issue.date,
        url: story.url,
        title: story.title,
        publishedAt: `${issue.date}T00:00:00.000Z`,
      });
    }
  }

  if (items.length === 0) {
    return { ok: false, reason: 'contract', message: `выпуски не разобрались: ${failures.join('; ')}` };
  }
  return { ok: true, items };
}
