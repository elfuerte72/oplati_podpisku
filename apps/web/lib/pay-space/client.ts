import {
  paySpaceCreateCardResponseSchema,
  paySpaceErrorSchema,
  paySpaceGetCardResponseSchema,
  paySpaceTopupResponseSchema,
  type PaySpaceCreateCardRequest,
  type PaySpaceCreateCardResponse,
  type PaySpaceGetCardResponse,
  type PaySpaceTopupRequest,
  type PaySpaceTopupResponse,
} from '@oplati/types';

import type { Logger } from '../logger.ts';
import { PaySpaceApiError, PaySpaceContractError } from './errors.ts';

/**
 * HTTP-клиент app.pay.space.
 *
 * - Bearer Authorization (header `Authorization: Bearer <PAYSPACE_API_KEY>`).
 *   Точный формат уточняется при подключении к sandbox (TODO).
 * - Timeout 60s (выпуск карты медленный).
 * - Retry: max 2 для 5xx; 4xx не ретраим.
 * - Zod-парсинг через `@oplati/types`. Контракт-дрифт → `PaySpaceContractError`.
 *
 * SECURITY: НИКОГДА не логировать `pan` и `cvc` (даже на DEBUG). `panMasked`
 * можно — это уже редактированный PAN.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export type PaySpaceClientOptions = {
  apiKey: string;
  accountId: string;
  baseUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
};

export class PaySpaceClient {
  private readonly apiKey: string;
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaySpaceClientOptions) {
    this.apiKey = opts.apiKey;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async createCard(
    input: Omit<PaySpaceCreateCardRequest, 'accountId'>,
  ): Promise<PaySpaceCreateCardResponse> {
    this.log.info({
      event: 'paypace.create_card.start',
      externalUserId: input.externalUserId,
      initialBalanceUsdCents: input.initialBalanceUsdCents,
    });
    const resp = await this.requestJson(
      'POST',
      '/cards',
      { ...input, accountId: this.accountId },
      paySpaceCreateCardResponseSchema.parse,
    );
    this.log.info({
      event: 'paypace.create_card.ok',
      cardId: resp.cardId,
      panMasked: resp.panMasked, // panMasked — это маска, не полный PAN
      balanceUsdCents: resp.balanceUsdCents,
    });
    return resp;
  }

  async topupCard(input: PaySpaceTopupRequest): Promise<PaySpaceTopupResponse> {
    return await this.requestJson(
      'POST',
      `/cards/${encodeURIComponent(input.cardId)}/topup`,
      { amountUsdCents: input.amountUsdCents },
      paySpaceTopupResponseSchema.parse,
    );
  }

  async getCard(cardId: string): Promise<PaySpaceGetCardResponse> {
    return await this.requestJson(
      'GET',
      `/cards/${encodeURIComponent(cardId)}`,
      null,
      paySpaceGetCardResponseSchema.parse,
    );
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const bodyText = body === null ? '' : JSON.stringify(body);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      this.log.debug({ event: 'paypace.request', method, path, attempt });

      try {
        const resp = await this.fetchImpl(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            // TODO: уточнить точный формат при подключении к sandbox.
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: method === 'GET' ? undefined : bodyText,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const respText = await resp.text();

        if (resp.ok) {
          let raw: unknown;
          try {
            raw = JSON.parse(respText);
          } catch (err) {
            throw new PaySpaceContractError(
              resp.status,
              `Non-JSON success response: ${(err as Error).message}`,
              respText,
            );
          }
          try {
            return parse(raw);
          } catch (err) {
            throw new PaySpaceContractError(
              resp.status,
              `Schema mismatch: ${(err as Error).message}`,
              respText,
            );
          }
        }

        let errBody = { code: `HTTP_${resp.status}`, message: respText.slice(0, 500) };
        try {
          const parsed = paySpaceErrorSchema.safeParse(JSON.parse(respText));
          if (parsed.success) errBody = parsed.data;
        } catch {
          // оставляем дефолтный errBody.
        }

        const retryable = resp.status >= 500;
        if (retryable && attempt < MAX_RETRIES - 1) {
          const backoffMs = 1000 * Math.pow(2, attempt);
          this.log.warn({
            event: 'paypace.retry',
            method,
            path,
            attempt,
            httpStatus: resp.status,
            backoffMs,
          });
          await sleep(backoffMs);
          continue;
        }

        const apiErr = new PaySpaceApiError({
          code: errBody.code,
          httpStatus: resp.status,
          message: errBody.message,
        });
        this.log.error({
          event: 'paypace.error',
          method,
          path,
          code: apiErr.code,
          httpStatus: apiErr.httpStatus,
          message: apiErr.message,
        });
        throw apiErr;
      } catch (err) {
        clearTimeout(timeoutId);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const isContract = err instanceof PaySpaceContractError;
        if (!isContract && (isAbort || (err instanceof TypeError && /fetch/i.test(err.message))) && attempt < MAX_RETRIES - 1) {
          const backoffMs = 1000 * Math.pow(2, attempt);
          this.log.warn({
            event: 'paypace.retry',
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

    throw lastError ?? new Error('paypace: retries exhausted');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
