import {
  loveAndPayInvoiceResponseSchema,
  loveAndPayErrorSchema,
  type LoveAndPayInvoice,
  type LoveAndPayInvoiceRequest,
  type LoveAndPayInvoiceResponse,
} from '@oplati/types';

import type { Logger } from '../logger.ts';
import { LoveAndPayApiError, LoveAndPayContractError } from './errors.ts';
import { signRequest } from './sign.ts';

/**
 * HTTP-клиент Love & Pay (https://loveandpay.io/api/v2).
 *
 * - HMAC v2 подпись исходящих (см. `./sign.ts`).
 * - `fetch` всегда с `AbortController` (timeout 30s — L&P медленный).
 * - Retry для 429/5xx: max 3, exponential backoff (500ms, 1s, 2s). 400/401/403 — no-retry.
 * - Zod-парсинг ответов через `@oplati/types`. Контракт-дрифт → `LoveAndPayContractError`.
 *
 * Singleton через `getLoveAndPayClient()` в `./index.ts` (lazy init, чтобы build
 * не падал без env'ов).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export type LoveAndPayClientOptions = {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  logger: Logger;
  /** Override fetch (для тестов / моков). */
  fetchImpl?: typeof fetch;
};

export class LoveAndPayClient {
  private readonly apiKey: string;
  private readonly secretKey: string;
  /** Origin без path (https://loveandpay.io) — для конструирования URL. */
  private readonly origin: string;
  /**
   * Полный API-path с префиксом версии (`/api/v2`), без trailing slash.
   * КРИТИЧНО для подписи: документация L&P требует, чтобы в HMAC шёл ПОЛНЫЙ
   * path начиная с `/api/v2/...`, а не короткий `/invoices`. Иначе сервер
   * возвращает INVALID_SIGNATURE.
   */
  private readonly apiPath: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LoveAndPayClientOptions) {
    this.apiKey = opts.apiKey;
    this.secretKey = opts.secretKey;
    const u = new URL(opts.baseUrl);
    this.origin = `${u.protocol}//${u.host}`;
    this.apiPath = u.pathname.replace(/\/$/, ''); // '/api/v2'
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  // ─── Public methods ──────────────────────────────────────────────────────

  async createInvoice(input: LoveAndPayInvoiceRequest): Promise<LoveAndPayInvoiceResponse> {
    return await this.requestJson('POST', '/invoices', input, loveAndPayInvoiceResponseSchema.parse);
  }

  async createCardInvoice(
    input: Omit<LoveAndPayInvoiceRequest, 'paymentMethod'>,
  ): Promise<LoveAndPayInvoiceResponse> {
    return await this.requestJson(
      'POST',
      '/invoices',
      { ...input, paymentMethod: 'card' as const },
      loveAndPayInvoiceResponseSchema.parse,
    );
  }

  async getInvoice(id: string): Promise<LoveAndPayInvoice> {
    const resp = await this.requestJson(
      'GET',
      `/invoices/${encodeURIComponent(id)}`,
      null,
      loveAndPayInvoiceResponseSchema.parse,
    );
    return resp.invoice;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const bodyText = body === null ? '' : JSON.stringify(body);
    // signPath = '/api/v2/invoices' — ПОЛНЫЙ путь для HMAC (без query).
    const signPath = `${this.apiPath}${path}`;
    const url = `${this.origin}${signPath}`;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { timestamp, signature } = signRequest(method, signPath, bodyText, this.secretKey);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      this.log.debug({
        event: 'loveandpay.request',
        method,
        path: signPath,
        timestamp,
        attempt,
      });

      try {
        const resp = await this.fetchImpl(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            // Документация L&P использует lowercase — синхронизируем
            // (HTTP заголовки case-insensitive, но иначе не совпадаем с docs).
            'x-api-key': this.apiKey,
            'x-timestamp': timestamp,
            'x-signature': signature,
          },
          body: method === 'GET' ? undefined : bodyText,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const respText = await resp.text();

        // 2xx — парсим успех.
        if (resp.ok) {
          let raw: unknown;
          try {
            raw = JSON.parse(respText);
          } catch (err) {
            throw new LoveAndPayContractError(
              resp.status,
              `Non-JSON success response: ${(err as Error).message}`,
              respText,
            );
          }
          try {
            const parsed = parse(raw);
            this.log.info({
              event: 'loveandpay.response.ok',
              method,
              path,
              status: resp.status,
            });
            return parsed;
          } catch (err) {
            throw new LoveAndPayContractError(
              resp.status,
              `Response schema mismatch: ${(err as Error).message}`,
              respText,
            );
          }
        }

        // 4xx/5xx — пробуем распарсить error-shape.
        const requestId = resp.headers.get('x-request-id') ?? undefined;
        let errBody: { code: string; message: string } = {
          code: `HTTP_${resp.status}`,
          message: respText.slice(0, 500),
        };
        try {
          const json: unknown = JSON.parse(respText);
          const nested = loveAndPayErrorSchema.safeParse(json);
          if (nested.success) {
            // Вложенный контракт: { success: false, error: { code, message } }.
            errBody = {
              code:
                typeof nested.data.error.code === 'string'
                  ? nested.data.error.code
                  : `HTTP_${resp.status}`,
              message: nested.data.error.message,
            };
          } else if (json !== null && typeof json === 'object') {
            // Плоский контракт L&P: { error, message?, hint?, code? }. Раньше он
            // терялся как HTTP_4xx с сырым телом — теперь даём читаемый code/message.
            const flat = json as Record<string, unknown>;
            const code =
              typeof flat.code === 'string'
                ? flat.code
                : typeof flat.error === 'string'
                  ? flat.error
                  : `HTTP_${resp.status}`;
            const baseMessage =
              typeof flat.message === 'string'
                ? flat.message
                : typeof flat.error === 'string'
                  ? flat.error
                  : respText.slice(0, 500);
            const hint = typeof flat.hint === 'string' ? ` (${flat.hint})` : '';
            errBody = { code, message: `${baseMessage}${hint}` };
          }
        } catch {
          // не-JSON тело — оставляем дефолтный errBody с обрезанным текстом.
        }

        const retryable = resp.status === 429 || resp.status >= 500;
        if (retryable && attempt < MAX_RETRIES - 1) {
          const backoffMs = 500 * Math.pow(2, attempt);
          this.log.warn({
            event: 'loveandpay.retry',
            method,
            path,
            attempt,
            httpStatus: resp.status,
            code: errBody.code,
            backoffMs,
          });
          await sleep(backoffMs);
          continue;
        }

        const apiErr = new LoveAndPayApiError({
          code: errBody.code,
          httpStatus: resp.status,
          message: errBody.message,
          requestId,
        });
        this.log.error({
          event: 'loveandpay.error',
          method,
          path,
          code: apiErr.code,
          httpStatus: apiErr.httpStatus,
          requestId,
          message: apiErr.message,
        });
        throw apiErr;
      } catch (err) {
        clearTimeout(timeoutId);
        // AbortError / network: ретраим как 5xx.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const isContract = err instanceof LoveAndPayContractError;
        if (
          !isContract &&
          (isAbort || (err instanceof TypeError && /fetch/i.test(err.message))) &&
          attempt < MAX_RETRIES - 1
        ) {
          const backoffMs = 500 * Math.pow(2, attempt);
          this.log.warn({
            event: 'loveandpay.retry',
            method,
            path,
            attempt,
            reason: isAbort ? 'timeout' : 'network',
            backoffMs,
          });
          await sleep(backoffMs);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('loveandpay: retries exhausted');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
