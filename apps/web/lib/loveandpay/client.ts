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
 * HTTP-клиент Love & Pay (https://api.prod.loveandpay.io/api/v2; хост сменился
 * 2026-07-29, старый `loveandpay.io` гасится после 2026-08-01 — путь `/api/v2` при
 * этом сохранён, проверено живым вызовом).
 *
 * - HMAC v2 подпись исходящих (см. `./sign.ts`).
 * - `fetch` всегда с `AbortController` (timeout 30s — L&P медленный).
 * - Retry для 429/5xx/сети/таймаута: max 3, exponential backoff (500ms, 1s, 2s);
 *   400/401/403 — no-retry. НО повторяются только ИДЕМПОТЕНТНЫЕ запросы, а по
 *   умолчанию идемпотентен лишь GET: `POST /invoices` выполняется РОВНО ОДИН РАЗ.
 *   Причина — у L&P нет ключа идемпотентности: 5xx от их шлюза (как и таймаут,
 *   как и оборванный сокет) не отличим от «счёт создан, ответ потерян», поэтому
 *   повтор оставлял бы у провайдера второй счёт на тот же заказ. Ровно так же
 *   отключён ретрай у `createCard` в PaySpace и `createOrder` в Freekassa.
 *   Осиротевший счёт не страшен: клиент жмёт «Оплатить» ещё раз, а повторный
 *   confirm идемпотентно возвращает живой pending-инвойс (`repeat_confirm`).
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
  /** Origin без path (https://api.prod.loveandpay.io) — для конструирования URL. */
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
    opts: {
      /**
       * Можно ли безопасно повторить запрос. Дефолт — только GET: у L&P нет
       * ключа идемпотентности, поэтому любой POST по умолчанию выполняется один
       * раз. Дефолт выбран fail-safe специально — новый POST, добавленный без
       * этого флага, получит безопасное поведение, а не тихие дубли счетов.
       */
      idempotent?: boolean;
    } = {},
  ): Promise<T> {
    const bodyText = body === null ? '' : JSON.stringify(body);
    // signPath = '/api/v2/invoices' — ПОЛНЫЙ путь для HMAC (без query).
    const signPath = `${this.apiPath}${path}`;
    const url = `${this.origin}${signPath}`;
    const maxAttempts = (opts.idempotent ?? method === 'GET') ? MAX_RETRIES : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { timestamp, signature } = signRequest(method, signPath, bodyText, this.secretKey);

      const controller = new AbortController();
      let timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

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

        // Чтение тела — под СВОИМ таймаутом (аудит 2026-08-10). Заголовки
        // приходят рано, тело идёт потоком, и шлюз, отдавший 200 и замолчавший
        // на теле, подвешивал выставление счёта на всю `maxDuration` роута.
        // Таймер перевзводится, а не тянется остатком бюджета соединения: у
        // `POST /invoices` ретрая нет, и оборванное на теле тело означает
        // выставленный у L&P счёт, ссылку на который мы выбросили.
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const respText = await resp.text();
        clearTimeout(timeoutId);

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
        if (retryable && attempt < maxAttempts - 1) {
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
        // Сетевой сбой и таймаут ретраятся только у идемпотентных запросов
        // (`maxAttempts > 1`, то есть по умолчанию — только GET). Для POST
        // повтора не будет ни при каком типе ошибки: `TypeError: fetch failed`
        // в undici покрывает не только «соединение не установилось», но и
        // оборванный сокет ПОСЛЕ отправки тела, когда счёт у L&P уже создан.
        // Дрейф контракта (`LoveAndPayContractError`) не ретраится никогда:
        // ответ получен и разобран, повтор даст ту же ошибку.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const isContract = err instanceof LoveAndPayContractError;
        if (!isContract && (isAbort || isNetworkTypeError(err)) && attempt < maxAttempts - 1) {
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

/**
 * Сетевой сбой транспорта, а не наша ошибка типов.
 *
 * undici бросает `TypeError('fetch failed')`, когда соединение не установилось,
 * и `TypeError('terminated')`, когда сокет умер УЖЕ ПОСЛЕ заголовков — то есть
 * ровно на чтении тела, которое этот клиент теперь тоже держит под таймаутом.
 * Прежний предикат `/fetch/i` второй случай не ловил: обрыв на теле не
 * ретраился и не считался недоступностью провайдера (находка ревью 2026-08-11).
 */
export function isNetworkTypeError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed|terminated|network|socket/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
