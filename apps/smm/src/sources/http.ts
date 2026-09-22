import { smmConfig, type SmmConfig } from '../config/smm.config.ts';

/**
 * HTTP наружу. Единственное место в боте, где живёт голый `fetch` (канарейка
 * `boundaries.test.ts` это форсит).
 *
 * Правила дома, каждое из своего инцидента:
 *   - таймаут ОБЯЗАН покрывать чтение ТЕЛА, а не только заголовки: сервер,
 *     отдавший 200 и замолчавший на теле, вешал запрос навсегда (аудит
 *     2026-08-10);
 *   - лимит на размер тела: страница на сто мегабайт не должна съедать память
 *     контейнера с половиной гигабайта;
 *   - редиректы считаем САМИ и проверяем каждый шаг: иначе ссылка с сайта
 *     уводит на `file://` или на внутренний адрес;
 *   - ошибки транспорта — это Result, а не исключение.
 */

export type HttpFailure =
  | 'bad_url'
  | 'bad_protocol'
  | 'too_many_redirects'
  | 'timeout'
  | 'transport'
  | 'http_error'
  | 'unsupported_type'
  | 'too_large';

export interface HttpTextResult {
  readonly ok: true;
  /** Адрес после редиректов: по нему считается домен источника. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  /** true — тело было длиннее лимита и обрезано. */
  readonly truncated: boolean;
}

export interface HttpBytesResult {
  readonly ok: true;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface HttpError {
  readonly ok: false;
  readonly reason: HttpFailure;
  readonly message: string;
  readonly status?: number;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly accept?: string;
  readonly fetcher?: Fetcher;
  readonly config?: SmmConfig;
}

const DEFAULT_MAX_REDIRECTS = 5;

/** Сетевые ошибки undici: обрыв сокета после заголовков — тоже транспорт. */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /fetch failed|terminated|network|socket/i.test(error.message);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function checkUrl(raw: string): { ok: true; url: URL } | HttpError {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad_url', message: `не похоже на адрес: ${raw.slice(0, 120)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'bad_protocol', message: `схема ${url.protocol} не поддерживается` };
  }
  return { ok: true, url };
}

interface RawResponse {
  readonly response: Response;
  readonly url: string;
}

/**
 * Запрос с ручным обходом редиректов. Возвращает ответ, тело которого ещё НЕ
 * прочитано: чтение идёт под тем же сигналом, что и запрос.
 */
async function request(
  raw: string,
  init: RequestInit,
  options: { maxRedirects: number; fetcher: Fetcher },
): Promise<RawResponse | HttpError> {
  let current = raw;
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const checked = checkUrl(current);
    if (!('url' in checked)) return checked;

    const response = await options.fetcher(checked.url.toString(), { ...init, redirect: 'manual' });
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return { response, url: checked.url.toString() };

    const location = response.headers.get('location');
    if (location === null || location === '') {
      return { ok: false, reason: 'http_error', message: `редирект ${response.status} без Location`, status: response.status };
    }
    current = new URL(location, checked.url).toString();
  }
  return {
    ok: false,
    reason: 'too_many_redirects',
    message: `больше ${options.maxRedirects} редиректов`,
  };
}

/**
 * Ожидание отмены как промис. Нужно, чтобы чтение тела обрывалось НАШИМ
 * дедлайном, а не надеждой на то, что транспорт честно реагирует на `signal`:
 * поток, который отдал первый кусок и замолчал, иначе держит шаг навсегда.
 */
function abortion(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = (): void => {
      const error = new Error('чтение тела прервано по таймауту');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/** Читает тело по кускам, останавливаясь на лимите или на дедлайне. */
async function readLimited(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const watch = signal === undefined ? undefined : abortion(signal);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
  for (;;) {
    const { done, value } =
      watch === undefined
        ? await reader.read()
        : await Promise.race([reader.read(), watch.promise]);
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      // Читать дальше незачем: страница уже больше лимита.
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  } finally {
    watch?.dispose();
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, bytes.length - offset));
    bytes.set(slice, offset);
    offset += slice.byteLength;
  }
  return { bytes, truncated };
}

async function fetchBytes(
  url: string,
  options: HttpOptions,
): Promise<HttpBytesResult | (HttpError & { truncated?: boolean })> {
  const config = options.config ?? smmConfig;
  const timeoutMs = options.timeoutMs ?? config.http.articleTimeoutMs;
  const maxBytes = options.maxBytes ?? config.http.articleMaxBytes;
  const fetcher = options.fetcher ?? ((target, init) => fetch(target, init));

  const controller = new AbortController();
  // Таймер снимается ТОЛЬКО после чтения тела: иначе «200 и тишина» вешает
  // шаг навсегда.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const attempt = await request(
      url,
      {
        signal: controller.signal,
        headers: {
          'user-agent': config.http.userAgent,
          accept: options.accept ?? 'text/html,application/xhtml+xml,*/*',
        },
      },
      { maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, fetcher },
    );
    if ('ok' in attempt && attempt.ok === false) return attempt;

    const { response, url: finalUrl } = attempt as RawResponse;
    if (!response.ok) {
      return {
        ok: false,
        reason: 'http_error',
        message: `ответ ${response.status}`,
        status: response.status,
      };
    }
    const { bytes, truncated } = await readLimited(response, maxBytes, controller.signal);
    return {
      ok: true,
      url: finalUrl,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      bytes,
      ...(truncated ? { truncated } : {}),
    } as HttpBytesResult;
  } catch (error) {
    if (isAbort(error)) {
      return { ok: false, reason: 'timeout', message: `ответ не пришёл за ${timeoutMs} мс` };
    }
    if (isNetworkError(error)) {
      return { ok: false, reason: 'transport', message: error instanceof Error ? error.message : String(error) };
    }
    return {
      ok: false,
      reason: 'transport',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Текст страницы. Тело длиннее лимита обрезается, а не роняет запрос. */
export async function fetchText(url: string, options: HttpOptions = {}): Promise<HttpTextResult | HttpError> {
  const result = await fetchBytes(url, options);
  if (!result.ok) return result;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(result.bytes);
  return {
    ok: true,
    url: result.url,
    status: result.status,
    contentType: result.contentType,
    text,
    truncated: (result as { truncated?: boolean }).truncated === true,
  };
}

/** Байты картинки с проверкой типа: не картинку в пост не ставим. */
export async function fetchImage(
  url: string,
  options: HttpOptions = {},
): Promise<HttpBytesResult | HttpError> {
  const config = options.config ?? smmConfig;
  const result = await fetchBytes(url, {
    ...options,
    accept: 'image/*',
    maxBytes: options.maxBytes ?? config.http.imageMaxBytes,
  });
  if (!result.ok) return result;
  if (!/^image\/(png|jpeg|jpg|webp)/i.test(result.contentType)) {
    return {
      ok: false,
      reason: 'unsupported_type',
      message: `тип ${result.contentType || 'неизвестен'}: нужен png, jpeg или webp`,
    };
  }
  return result;
}

export interface JsonOptions extends HttpOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** JSON-запрос к API источника. Разбор — тоже под таймаутом и лимитом. */
export async function fetchJson<T>(
  url: string,
  options: JsonOptions = {},
): Promise<({ ok: true; value: T } & { status: number }) | HttpError> {
  const config = options.config ?? smmConfig;
  const timeoutMs = options.timeoutMs ?? config.http.articleTimeoutMs;
  const fetcher = options.fetcher ?? ((target, init) => fetch(target, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const checked = checkUrl(url);
    if (!('url' in checked)) return checked;
    const response = await fetcher(checked.url.toString(), {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: {
        'user-agent': config.http.userAgent,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    // Тело читается ДО проверки статуса: у ошибки провайдера в теле лежит
    // причина, и она нужна в логе.
    const { bytes } = await readLimited(
      response,
      options.maxBytes ?? config.http.articleMaxBytes,
      controller.signal,
    );
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!response.ok) {
      return {
        ok: false,
        reason: 'http_error',
        message: `ответ ${response.status}: ${raw.slice(0, 200)}`,
        status: response.status,
      };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as T, status: response.status };
    } catch (error) {
      return {
        ok: false,
        reason: 'transport',
        message: `ответ не разобрался как JSON: ${error instanceof Error ? error.message : String(error)}`,
        status: response.status,
      };
    }
  } catch (error) {
    if (isAbort(error)) return { ok: false, reason: 'timeout', message: `ответ не пришёл за ${timeoutMs} мс` };
    return {
      ok: false,
      reason: 'transport',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
