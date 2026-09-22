import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { documentTitle, linkHref, mainText, metaContent } from './html.ts';
import { fetchImage, fetchText, type Fetcher, type HttpError } from './http.ts';

/**
 * Статья-первоисточник: заголовок, текст, обложка. По этому досье потом пишется
 * пост, поэтому здесь важнее полнота фактов, чем красота разбора.
 */

export interface Article {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly ogImage?: string;
  readonly siteName?: string;
  readonly publishedAt?: string;
  /** true — страница была длиннее лимита и текст обрезан. */
  readonly truncated: boolean;
}

export type ArticleFailure =
  | 'telegram_post_not_source'
  | 'empty_article'
  | HttpError['reason'];

export type ArticleResult =
  | { readonly ok: true; readonly article: Article }
  | { readonly ok: false; readonly reason: ArticleFailure; readonly message: string };

/**
 * Слова в адресе картинки, по которым видно, что это не обложка: логотип,
 * иконка, аватар, распорка. Правило прежнего контура (`fetch_article_image`):
 * логотип во весь кадр в посте выглядит как реклама чужого бренда.
 */
const BAD_IMAGE_WORDS = [
  'logo',
  'icon',
  'avatar',
  'sprite',
  'pixel',
  'badge',
  'button',
  'favicon',
  'emoji',
  '1x1',
  'spacer',
  'placeholder',
];

export function looksLikeLogo(url: string): boolean {
  const low = url.toLowerCase();
  return BAD_IMAGE_WORDS.some((word) => low.includes(word));
}

/** Страница Telegram источником не бывает: наружу идёт только первоисточник. */
export function isTelegramUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(url);
}

function absolute(candidate: string, base: string): string | undefined {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return undefined;
  }
}

/** Обложка страницы: og:image, twitter:image, link rel=image_src. */
export function pickCover(html: string, baseUrl: string): string | undefined {
  const candidates = [
    metaContent(html, ['og:image', 'og:image:url', 'og:image:secure_url']),
    metaContent(html, ['twitter:image', 'twitter:image:src']),
    linkHref(html, ['image_src']),
  ].filter((value): value is string => value !== undefined);

  for (const candidate of candidates) {
    const url = absolute(candidate, baseUrl);
    if (url === undefined) continue;
    if (looksLikeLogo(url)) continue;
    // Провайдер иногда отдаёт размеры рядом: маленькая картинка обложкой не
    // бывает, даже если в адресе нет слова logo.
    const width = Number(metaContent(html, ['og:image:width']) ?? '0');
    const height = Number(metaContent(html, ['og:image:height']) ?? '0');
    if (width > 0 && height > 0 && (width < 320 || height < 180)) continue;
    return url;
  }
  return undefined;
}

function pickPublishedAt(html: string): string | undefined {
  const raw =
    metaContent(html, ['article:published_time', 'og:article:published_time', 'date', 'pubdate']) ??
    /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export interface FetchArticleOptions {
  readonly fetcher?: Fetcher;
  readonly config?: SmmConfig;
  readonly timeoutMs?: number;
}

export async function fetchArticle(
  url: string,
  options: FetchArticleOptions = {},
): Promise<ArticleResult> {
  if (isTelegramUrl(url)) {
    return {
      ok: false,
      reason: 'telegram_post_not_source',
      message: 'чужой пост в Telegram источником не бывает: дай адрес первоисточника',
    };
  }

  const page = await fetchText(url, {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!page.ok) return { ok: false, reason: page.reason, message: page.message };

  const title =
    metaContent(page.text, ['og:title']) ?? documentTitle(page.text) ?? '';
  const text = mainText(page.text);
  if (text.trim().length < 200) {
    // Двести знаков — это не статья: так выглядят страницы с пейволлом,
    // капчей и редиректом через скрипт. Пост по ним писать нечего.
    return {
      ok: false,
      reason: 'empty_article',
      message: 'на странице нет читаемого текста статьи (пейволл, капча или только скрипт)',
    };
  }

  const cover = pickCover(page.text, page.url);
  const siteName = metaContent(page.text, ['og:site_name']);
  const publishedAt = pickPublishedAt(page.text);

  return {
    ok: true,
    article: {
      url: page.url,
      title: title === '' ? page.url : title,
      text,
      truncated: page.truncated,
      ...(cover === undefined ? {} : { ogImage: cover }),
      ...(siteName === undefined ? {} : { siteName }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    },
  };
}

export interface SaveImageOptions extends FetchArticleOptions {
  /** Куда класть файл. По умолчанию каталог картинок из конфига бота. */
  readonly dir: string;
  /** Имя без расширения: обычно id поста. */
  readonly name: string;
}

export type SaveImageResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/** Скачивает обложку в файл. Тип и размер проверяются до записи. */
export async function saveImage(
  url: string,
  options: SaveImageOptions,
): Promise<SaveImageResult> {
  const config = options.config ?? smmConfig;
  const result = await fetchImage(url, {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    config,
    maxBytes: config.http.imageMaxBytes,
  });
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };

  const extension = /webp/i.test(result.contentType)
    ? '.webp'
    : /png/i.test(result.contentType)
      ? '.png'
      : '.jpg';
  const path = join(options.dir, `${options.name}${extension}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, result.bytes);
  } catch (error) {
    return { ok: false, reason: 'write_failed', message: String(error) };
  }
  return { ok: true, path };
}

/** Ключ кэша статьи: адрес после редиректов может быть длинным и грязным. */
export function articleKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}
