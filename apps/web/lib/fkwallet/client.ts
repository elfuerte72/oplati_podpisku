import { createHash } from 'node:crypto';

import {
  fkWalletBalanceResponseSchema,
  fkWalletErrorResponseSchema,
  type FkWalletBalanceEntry,
} from '@oplati/types';

import type { Logger } from '../logger.ts';
import { FkWalletApiError, FkWalletContractError } from './errors.ts';

/**
 * HTTP-клиент кошелька FKWallet.io — ТОЛЬКО чтение.
 *
 * Зачем: касса Freekassa выводит рубли только на этот кошелёк, и без его
 * остатка раздел «Финансы» показывал бы путь денег с дырой посередине.
 *
 * Что здесь намеренно НЕТ: вывода, перевода и обмена. У провайдера они
 * подписываются тем же приватным ключом, что и чтение, — то есть ключ,
 * который держит приложение, умеет двигать деньги. Методов для этого в
 * клиенте не заведено, и заводить их можно только вместе с тикетами трека
 * treasury (спека, §4.3) — не «раз уж ключ есть».
 *
 * Контракт (из OpenAPI-схемы кошелька, живым вызовом пока не подтверждён):
 *  - `GET {base}/{public_key}/{resource}`;
 *  - `Authorization: Bearer <sha256-hex(тело + приватный ключ)>`, у GET без
 *    тела — `sha256-hex(приватный ключ)`;
 *  - ответ `{ status: 'ok', data }`, дрейф формы → `FkWalletContractError`,
 *    отказ провайдера → `FkWalletApiError`.
 *
 * ⚠️ Публичный ключ стоит В АДРЕСЕ каждого запроса, и вместе с приватным это
 * полный доступ к кошельку: ни URL, ни заголовки в логи не пишутся — только
 * имя ресурса.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export type FkWalletClientOptions = {
  publicKey: string;
  privateKey: string;
  baseUrl: string;
  logger: Logger;
  /** Override fetch (для тестов). */
  fetchImpl?: typeof fetch;
};

/** Дедлайн чтения задаёт вызывающий; экран панели держит короткий. */
export type FkWalletReadOptions = {
  timeoutMs?: number;
};

export class FkWalletClient {
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FkWalletClientOptions) {
    this.publicKey = opts.publicKey;
    this.privateKey = opts.privateKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** `GET /balance` — остаток кошелька по валютам (`RUB`, `USDT`, …). */
  async getBalance(opts?: FkWalletReadOptions): Promise<FkWalletBalanceEntry[]> {
    const resp = await this.getJson(
      'balance',
      (raw) => fkWalletBalanceResponseSchema.parse(raw),
      opts?.timeoutMs,
    );
    return resp.data;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Подпись GET без тела: sha256 приватного ключа, hex — как в PHP-эталоне доки. */
  private signEmptyBody(): string {
    return createHash('sha256').update(this.privateKey).digest('hex');
  }

  private async getJson<T>(
    resource: string,
    parse: (raw: unknown) => T,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}/${encodeURIComponent(this.publicKey)}/${resource}`;
    this.log.info({ event: 'fkwallet.request', resource });

    const budgetMs =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), budgetMs);

    let resp: Response;
    let respText: string;
    try {
      // Таймер держится и на чтении тела (конвенция проекта): ответ с
      // заголовками и молчащим телом не должен вешать экран.
      resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.signEmptyBody()}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      respText = await resp.text();
    } finally {
      clearTimeout(timeoutId);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(respText);
    } catch (err) {
      throw new FkWalletContractError(
        resp.status,
        `Non-JSON response: ${(err as Error).message}`,
        respText,
      );
    }

    // Отказ провайдер сигналит полем `status`; HTTP-статус при этом может быть
    // любым — проверяем тело, а не только статус.
    const asError = fkWalletErrorResponseSchema.safeParse(raw);
    if (asError.success) {
      const message =
        asError.data.message ?? asError.data.desc ?? asError.data.error ?? respText.slice(0, 300);
      this.log.error({ event: 'fkwallet.error', resource, httpStatus: resp.status, message });
      throw new FkWalletApiError({
        code: `HTTP_${resp.status}`,
        httpStatus: resp.status,
        message,
      });
    }

    if (!resp.ok) {
      throw new FkWalletApiError({
        code: `HTTP_${resp.status}`,
        httpStatus: resp.status,
        message: respText.slice(0, 300),
      });
    }

    try {
      const parsed = parse(raw);
      this.log.info({ event: 'fkwallet.response.ok', resource, status: resp.status });
      return parsed;
    } catch (err) {
      throw new FkWalletContractError(
        resp.status,
        `Response schema mismatch: ${(err as Error).message}`,
        respText,
      );
    }
  }
}
