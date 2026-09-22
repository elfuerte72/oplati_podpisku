import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fetchArticle,
  fetchJson,
  fetchText,
  looksLikeLogo,
  looksLikeUrl,
  normalizeUrl,
  pickCover,
  resolveSource,
  saveImage,
  searchNews,
  type Fetcher,
} from './index.ts';
import { decodeEntities } from './html.ts';
import {
  ARTICLE_HTML,
  DIV_ONLY_HTML,
  ENTITIES_HTML,
  FIXTURE_LEAD,
  LOGO_COVER_HTML,
  PAYWALL_HTML,
  SMALL_COVER_HTML,
  TWITTER_COVER_HTML,
} from './fixtures.ts';

/**
 * DNS в тестах свой: живой резолв сделал бы прогон зависимым от сети и от
 * того, существует ли домен фикстуры на самом деле.
 */
const publicDns = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);

/** Ответ-фикстура: тело отдаётся потоком, как у настоящего fetch. */
function html(body: string, init: { status?: number; contentType?: string; url?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
  });
}

function fetcherFor(pages: Record<string, Response | (() => Response)>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = (url) => {
    calls.push(url);
    const page = pages[url];
    if (page === undefined) return Promise.resolve(new Response('нет такой страницы', { status: 404 }));
    return Promise.resolve(typeof page === 'function' ? page() : page);
  };
  return { fetcher, calls };
}

describe('fetchText', () => {
  it('отдаёт текст страницы и конечный адрес', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/post': html('<p>привет</p>') });
    const result = await fetchText('https://example.com/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('привет');
    expect(result.url).toBe('https://example.com/post');
    expect(result.truncated).toBe(false);
  });

  it('тело больше лимита обрезается, а не роняет запрос', async () => {
    const big = 'а'.repeat(50_000);
    const { fetcher } = fetcherFor({ 'https://example.com/big': html(big) });
    const result = await fetchText('https://example.com/big', { fetcher, resolver: publicDns, maxBytes: 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(2000);
  });

  it('редиректы идут по шагам и считаются', async () => {
    const { fetcher, calls } = fetcherFor({
      'https://example.com/a': new Response(null, { status: 302, headers: { location: '/b' } }),
      'https://example.com/b': html('<p>цель</p>'),
    });
    const result = await fetchText('https://example.com/a', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://example.com/b');
    expect(calls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('петля редиректов обрывается', async () => {
    const loop: Fetcher = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: '/next' } }));
    const result = await fetchText('https://example.com/start', { resolver: publicDns, fetcher: loop, maxRedirects: 3 });
    expect(result).toMatchObject({ ok: false, reason: 'too_many_redirects' });
  });

  it('не http-схема отвергается до запроса', async () => {
    const { fetcher, calls } = fetcherFor({});
    const result = await fetchText('file:///etc/passwd', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'bad_protocol' });
    expect(calls).toEqual([]);
  });

  it('ошибка HTTP приходит Result-ом с кодом', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/404': html('нет', { status: 404 }) });
    const result = await fetchText('https://example.com/404', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'http_error', status: 404 });
  });

  it('сетевая ошибка не бросает наружу', async () => {
    const broken: Fetcher = () => Promise.reject(new TypeError('fetch failed'));
    const result = await fetchText('https://example.com/x', { resolver: publicDns, fetcher: broken });
    expect(result).toMatchObject({ ok: false, reason: 'transport' });
  });

  it('таймаут покрывает чтение ТЕЛА, а не только заголовки', async () => {
    // Инцидент 2026-08-10: сервер отдал 200 и замолчал на теле — запрос висел
    // навсегда. Поток отдаёт первый кусок и больше ничего.
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<p>начало'));
        // Второй кусок не приходит никогда.
      },
    });
    // Двойник НЕ реагирует на `signal` намеренно: проверяется, что дедлайн
    // держит наш код, а не добрая воля транспорта. Гасить поток тут нельзя —
    // он захвачен читателем, и `cancel()` отвечает отказом в пустоту.
    const slow: Fetcher = () =>
      Promise.resolve(
        new Response(slowBody, { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    const started = Date.now();
    const result = await fetchText('https://example.com/slow', { resolver: publicDns, fetcher: slow, timeoutMs: 120 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['timeout', 'transport']).toContain(result.reason);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('fetchArticle', () => {
  it('берёт заголовок, текст, обложку, сайт и дату', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/post': html(ARTICLE_HTML) });
    const result = await fetchArticle('https://example.com/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { article } = result;
    expect(article.title).toBe('Google открыла память Gemini всем');
    expect(article.text).toContain(FIXTURE_LEAD);
    expect(article.ogImage).toBe('https://example.com/images/cover-gemini.jpg');
    expect(article.siteName).toBe('Example Blog');
    expect(article.publishedAt).toBe('2026-09-18T10:00:00.000Z');
  });

  it('меню, подвал и скрипты в текст не попадают', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/post': html(ARTICLE_HTML) });
    const result = await fetchArticle('https://example.com/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.text).not.toContain('Все права защищены');
    expect(result.article.text).not.toContain('tracker');
    expect(result.article.text).not.toContain('Читайте также');
    // Короткая подпись — не абзац статьи.
    expect(result.article.text).not.toContain('Короткая подпись');
  });

  it('логотип обложкой не берётся', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/post': html(LOGO_COVER_HTML) });
    const result = await fetchArticle('https://example.com/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.article.ogImage).toBeUndefined();
    expect(looksLikeLogo('https://cdn.example.com/static/logo-512.png')).toBe(true);
    expect(looksLikeLogo('https://cdn.example.com/media/cover.jpg')).toBe(false);
  });

  it('маленькая картинка обложкой не берётся', async () => {
    expect(pickCover(SMALL_COVER_HTML, 'https://example.com/post')).toBeUndefined();
  });

  it('twitter:image годится, если og:image нет', async () => {
    expect(pickCover(TWITTER_COVER_HTML, 'https://example.com/post')).toBe(
      'https://cdn.example.com/media/shot.png',
    );
  });

  it('страница Telegram отвергается без запроса', async () => {
    const { fetcher, calls } = fetcherFor({});
    const result = await fetchArticle('https://t.me/durov/123', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'telegram_post_not_source' });
    expect(calls).toEqual([]);
  });

  it('пейволл — это не статья', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/pay': html(PAYWALL_HTML) });
    const result = await fetchArticle('https://example.com/pay', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'empty_article' });
  });

  it('разметка без абзацев тоже читается', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/div': html(DIV_ONLY_HTML) });
    const result = await fetchArticle('https://example.com/div', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.article.text).toContain('Google открыла память');
  });

  it('сущности HTML раскрываются', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/ent': html(ENTITIES_HTML) });
    const result = await fetchArticle('https://example.com/ent', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.text).toContain('«Gemini»');
    expect(result.article.text).toContain('"что мне с этого"');
    expect(result.article.text).not.toContain('&laquo;');
  });
});

describe('saveImage', () => {
  it('сохраняет картинку и определяет расширение по типу', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smm-img-'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }));
    const result = await saveImage('https://cdn.example.com/cover', { dir, name: 'post-1', fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path.endsWith('post-1.png')).toBe(true);
    expect(readFileSync(result.path).byteLength).toBe(4);
  });

  it('не картинку не сохраняет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smm-img-'));
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await saveImage('https://cdn.example.com/page', { dir, name: 'post-2', fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
  });
});

describe('searchNews', () => {
  const answer = (urls: string[]): Response =>
    new Response(
      JSON.stringify({
        results: urls.map((url, index) => ({
          url,
          title: `Заголовок ${index}`,
          content: 'Короткое описание материала для владельца.',
          published_date: '2026-09-18T10:00:00Z',
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('без ключа отвечает «поиск не настроен», а не падает', async () => {
    const result = await searchNews('память gemini');
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('объединяет русскую и английскую выдачу по домену', async () => {
    let call = 0;
    const fetcher: Fetcher = () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? answer(['https://ru.example.com/a', 'https://common.example.com/x'])
          : answer(['https://common.example.com/x', 'https://en.example.org/b']),
      );
    };
    const result = await searchNews('память gemini', { apiKey: 'tvly-test', fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map((c) => c.url)).toEqual([
      'https://ru.example.com/a',
      'https://common.example.com/x',
      'https://en.example.org/b',
    ]);
    // Первым остаётся русский: владельцу удобнее проверять по-русски.
    expect(result.candidates[1]?.language).toBe('ru');
  });

  it('пустая выдача — это «не нашлось», а не ошибка провайдера', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const result = await searchNews('тема', { apiKey: 'tvly-test', fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('отказ провайдера на обоих языках — ошибка провайдера', async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response('нет доступа', { status: 401 }));
    const result = await searchNews('тема', { apiKey: 'tvly-test', fetcher, resolver: publicDns });
    expect(result).toMatchObject({ ok: false, reason: 'provider_error' });
  });

  it('запрос уходит с темой news и окном недели', async () => {
    const bodies: unknown[] = [];
    const fetcher: Fetcher = (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(answer(['https://example.com/a']));
    };
    await searchNews('тема', { apiKey: 'tvly-test', fetcher, resolver: publicDns, languages: ['ru'] });
    expect(bodies[0]).toMatchObject({ topic: 'news', time_range: 'week', language: 'ru' });
  });
});

describe('resolveSource', () => {
  it('ссылка распознаётся и читается', async () => {
    const { fetcher } = fetcherFor({ 'https://example.com/post': html(ARTICLE_HTML) });
    const result = await resolveSource('https://example.com/post', { fetcher, resolver: publicDns });
    expect(result.kind).toBe('url');
  });

  it('адрес без протокола тоже ссылка', async () => {
    expect(looksLikeUrl('www.example.com/post')).toBe(true);
    expect(looksLikeUrl('example.com/post')).toBe(true);
    expect(normalizeUrl('www.example.com/post')).toBe('https://www.example.com/post');
    expect(looksLikeUrl('память gemini для всех')).toBe(false);
  });

  it('бренд Оплатишки в брифе — отказ БЕЗ обращений к сети и модели', async () => {
    const { fetcher, calls } = fetcherFor({});
    const result = await resolveSource('напиши про новую кнопку в Оплатишке', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ kind: 'refused', reason: 'product_is_human' });
    expect(calls).toEqual([]);
  });

  it('ссылка на Telegram — отказ с причиной', async () => {
    const { fetcher } = fetcherFor({});
    const result = await resolveSource('https://t.me/s/durov/123', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ kind: 'refused', reason: 'telegram_post_not_source' });
  });

  it('тема идёт в поиск', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [{ url: 'https://example.com/a', title: 'Заголовок' }] }), {
          status: 200,
        }),
      );
    const result = await resolveSource('память gemini для всех', { fetcher, resolver: publicDns, tavilyApiKey: 'tvly-test' });
    expect(result.kind).toBe('topic');
  });

  it('пустой ввод — отказ', async () => {
    const result = await resolveSource('   ');
    expect(result).toMatchObject({ kind: 'refused', reason: 'empty_input' });
  });

  it('непрочитанная статья — failed с причиной, а не отказ', async () => {
    // Владелец обязан различать «это не тема канала» и «страница не открылась».
    const { fetcher } = fetcherFor({ 'https://example.com/404': html('нет', { status: 404 }) });
    const result = await resolveSource('https://example.com/404', { fetcher, resolver: publicDns });
    expect(result).toMatchObject({ kind: 'failed', reason: 'http_error' });
  });
});

describe('внутренние адреса', () => {
  it('прямая ссылка на служебный адрес не запрашивается вовсе', async () => {
    const visited: string[] = [];
    const spy: Fetcher = (url) => {
      visited.push(url);
      return Promise.resolve(new Response('секрет', { status: 200 }));
    };
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3000/api/panel/events',
      'http://[::1]:8080/',
      'http://localhost/admin',
    ]) {
      const result = await fetchText(url, { resolver: publicDns, fetcher: spy });
      expect(result).toMatchObject({ ok: false, reason: 'private_address' });
    }
    expect(visited).toEqual([]);
  });

  it('редирект внутрь тоже отсекается: страницу выбирает не владелец', async () => {
    const visited: string[] = [];
    const spy: Fetcher = (url) => {
      visited.push(url);
      if (url.startsWith('https://news.example')) {
        return Promise.resolve(
          new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9999/secret' } }),
        );
      }
      return Promise.resolve(new Response('секрет', { status: 200 }));
    };
    const result = await fetchText('https://news.example/post', {
      fetcher: spy,
      resolver: () => Promise.resolve(['93.184.216.34']),
    });
    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
    expect(visited).toEqual(['https://news.example/post']);
  });

  it('имя, ведущее внутрь, отсекается по ответу DNS', async () => {
    const spy: Fetcher = () => Promise.resolve(new Response('ок', { status: 200 }));
    const result = await fetchText('https://rebind.example/page', {
      fetcher: spy,
      resolver: () => Promise.resolve(['10.0.0.5']),
    });
    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
  });

  it('несработавший DNS запрос не пропускает', async () => {
    const result = await fetchText('https://unknown.example/page', {
      fetcher: () => Promise.resolve(new Response('ок', { status: 200 })),
      resolver: () => Promise.reject(new Error('ENOTFOUND')),
    });
    expect(result).toMatchObject({ ok: false, reason: 'transport' });
  });
});

describe('кодировка страницы', () => {
  it('windows-1251 читается по charset из заголовка, а не мусором', async () => {
    const bytes = Buffer.from('<p>\xcf\xf0\xe8\xe2\xe5\xf2</p>', 'binary');
    const fetcher: Fetcher = () =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=windows-1251' },
        }),
      );
    const result = await fetchText('https://news.example/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Привет');
  });

  it('charset из <meta> тоже учитывается: заголовок его не назвал', async () => {
    const head = '<html><head><meta charset="windows-1251"></head><body><p>';
    const bytes = Buffer.concat([
      Buffer.from(head, 'latin1'),
      Buffer.from('\xcf\xf0\xe8\xe2\xe5\xf2', 'binary'),
      Buffer.from('</p></body></html>', 'latin1'),
    ]);
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await fetchText('https://news.example/post', { fetcher, resolver: publicDns });
    expect(result.ok && result.text).toContain('Привет');
  });

  it('незнакомая кодировка не роняет запрос', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(
        new Response('<p>ок</p>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=x-unknown-42' },
        }),
      );
    const result = await fetchText('https://news.example/post', { fetcher, resolver: publicDns });
    expect(result.ok).toBe(true);
  });
});

describe('сущности HTML', () => {
  it('раскрываются ОДИН раз: написанное словами не становится разметкой', () => {
    expect(decodeEntities('&#38;lt;b&#38;gt;')).toBe('&lt;b&gt;');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('обычные формы раскрываются', () => {
    expect(decodeEntities('&laquo;&#1055;&#x440;&#x438;&#x432;&#x435;&#x442;&raquo;')).toBe('«Привет»');
  });

  it('мусорный номер остаётся текстом, а не роняет разбор', () => {
    expect(decodeEntities('&#9999999999;')).toBe('&#9999999999;');
  });
});

describe('JSON-запрос к API', () => {
  it('редирект уводит запрос вместе с ключом — поэтому он проверяется', async () => {
    const visited: string[] = [];
    const spy: Fetcher = (url) => {
      visited.push(url);
      if (url.startsWith('https://api.example.com')) {
        return Promise.resolve(
          new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9/steal' } }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const result = await fetchJson('https://api.example.com/v1/data', {
      fetcher: spy,
      resolver: publicDns,
      headers: { 'x-api-key': 'секрет' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
    expect(visited).toEqual(['https://api.example.com/v1/data']);
  });
});

describe('секреты на редиректе', () => {
  it('на ЧУЖОЙ хост заголовок авторизации не переносится', async () => {
    const seen: { url: string; auth: unknown }[] = [];
    const spy: Fetcher = (url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers.authorization ?? headers['x-api-key'] });
      if (url.startsWith('https://api.example.com')) {
        return Promise.resolve(
          new Response('', { status: 302, headers: { location: 'https://other.example.org/collect' } }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await fetchJson('https://api.example.com/v1/data', {
      fetcher: spy,
      resolver: publicDns,
      headers: { authorization: 'Bearer sk-SUPER-SECRET' },
    });

    expect(seen[0]?.auth).toBe('Bearer sk-SUPER-SECRET');
    expect(seen[1]?.url).toBe('https://other.example.org/collect');
    expect(seen[1]?.auth).toBeUndefined();
  });

  it('на ТОТ ЖЕ хост заголовок сохраняется: это обычный редирект внутри API', async () => {
    const seen: unknown[] = [];
    const spy: Fetcher = (url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push(headers.authorization);
      if (url.endsWith('/v1/data')) {
        return Promise.resolve(
          new Response('', { status: 302, headers: { location: 'https://api.example.com/v2/data' } }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await fetchJson('https://api.example.com/v1/data', {
      fetcher: spy,
      resolver: publicDns,
      headers: { authorization: 'Bearer sk-SUPER-SECRET' },
    });

    expect(seen[1]).toBe('Bearer sk-SUPER-SECRET');
  });
});
