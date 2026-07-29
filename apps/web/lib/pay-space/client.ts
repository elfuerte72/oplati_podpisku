import {
  paySpaceAsyncOpDataSchema,
  paySpaceCardInfoDataSchema,
  paySpaceCreateCardDataSchema,
  paySpaceErrorSchema,
  paySpaceReleaseDataSchema,
  paySpaceTopupCheckDataSchema,
  paySpaceUserBalanceDataSchema,
  type PaySpaceAsyncOpStatus,
} from '@oplati/types';
import { z } from 'zod';

import type { Logger } from '../logger.ts';
import { PaySpaceApiError, PaySpaceContractError } from './errors.ts';
import {
  dollarStringToUsdCents,
  maskPan,
  parseExpDate,
  usdCentsToDollarString,
} from './format.ts';
import { canonicalQuery, signPaySpaceRequest } from './sign.ts';

/**
 * HTTP-клиент app.pay.space (виртуальные USD-карты, VCC).
 *
 * - База `https://app.pay.space/api/v1`; auth `Authorization: Bearer <API_KEY>`.
 * - Подпись запроса (HMAC, заголовки X-Timestamp/X-Nonce/X-Signature) — если
 *   задан `requestSecret` (см. sign.ts). Обязательна, раз секрет включён в кабинете.
 * - Обёртка ответа `{ success, data }` распаковывается здесь; `data` валидируется
 *   Zod-схемой из `@oplati/types`. Дрифт контракта → `PaySpaceContractError`.
 * - Суммы наружу — USD-центы (integer); конвертация в доллары-строки — format.ts.
 * - Timeout 60s; retry ×2 на 5xx/сеть; 4xx не ретраим. Не-идемпотентные POST
 *   (createCard — без request_id) НЕ ретраим вовсе (риск дубль-выпуска карты).
 *
 * SECURITY: НИКОГДА не логировать `pan`/`cvc` (даже на DEBUG). `panMasked` — можно.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

/**
 * Повторяем 5xx и 429.
 *
 * 429 добавлен отдельно и осознанно: это «слишком часто», то есть запрос
 * гарантированно НЕ обработан — повтор безопасен даже там, где идемпотентности
 * нет. Без него всплеск заказов ронял выпуск карты уже ПОСЛЕ приёма рублей.
 *
 * Предикат общий для обеих точек ретрая, а решение «повторять ли вообще»
 * остаётся за `maxAttempts`: у неидемпотентного `createCard` он равен 1, и
 * сюда управление не доходит.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
const DEFAULT_TOPUP_POLL_ATTEMPTS = 5;
const DEFAULT_TOPUP_POLL_DELAY_MS = 1500;

const envelopeSchema = z.object({ success: z.boolean() });

export type PaySpaceClientOptions = {
  apiKey: string;
  baseUrl: string;
  logger: Logger;
  /** HMAC-секрет подписи запросов. Без него запросы уходят без подписи. */
  requestSecret?: string;
  fetchImpl?: typeof fetch;
  /** Для тестов: подмена задержки между поллами topup/check. */
  sleepImpl?: (ms: number) => Promise<void>;
  topupPollAttempts?: number;
  topupPollDelayMs?: number;
};

// ─── Доменные типы (camelCase, USD-центы) ────────────────────────────────────

export type CreateCardInput = {
  amountUsdCents: number;
  /** YYYY-MM-DD; без него провайдер ставит +1 год. */
  expDate?: string;
  /** URL для вебхуков о тратах по карте. */
  callbackUrl?: string;
};

export type CreateCardResult = {
  cardId: string;
  /** Полный PAN — только в Telegram, не логировать/не хранить. */
  pan: string;
  panMasked: string;
  expMonth: number;
  expYear: number;
  /** CVC — только в Telegram, не логировать. */
  cvc: string;
  balanceUsdCents: number;
  network: string;
};

export type TopupCardInput = {
  cardId: string;
  amountUsdCents: number;
  /** Идемпотентный ключ (генерим из orderId). */
  requestId: string;
};

export type TopupCardResult = {
  cardId: string;
  requestId: string;
  status: PaySpaceAsyncOpStatus;
  /** Баланс карты после пополнения (из topup/check); null если ещё pending. */
  balanceUsdCents: number | null;
};

export type WithdrawCardInput = {
  cardId: string;
  amountUsdCents: number;
  requestId: string;
};

export type ReleaseCardResult = {
  cardId: string;
  /** Возвращённый на VCC-баланс остаток. */
  releasedUsdCents: number;
};

export type CardInfoResult = {
  cardId: string;
  panMasked: string;
  /** Сырой код статуса провайдера ("0".."9"). */
  statusCode: string;
  /** Человекочитаемый статус. */
  statusLabel: string;
  balanceUsdCents: number;
  /** Срок действия как отдал провайдер (MM/YY). */
  expDate: string;
  /** Тип карты у провайдера: MC/VISA, если отдан. */
  cardType: string | null;
  /** Код карточного продукта у PaySpace: например SG_SUB, если отдан. */
  productCode: string | null;
};

/**
 * Полные реквизиты карты для разового показа клиенту по запросу. НИКОГДА не
 * логировать, не сохранять в БД, не отправлять в Sentry — только в ответ
 * клиенту по защищённому каналу (инвариант безопасности реквизитов).
 */
export type CardSecrets = {
  /** Полный PAN (16 цифр). */
  cardNo: string;
  cvv: string;
  /** Срок MM/YY. */
  expDate: string;
};

export type VccBalanceResult = {
  balanceUsdCents: number;
  pendingUsdCents: number;
  currency: string;
};

const CARD_STATUS_LABELS: Record<string, string> = {
  '0': 'deactivated',
  '1': 'activated',
  '2': 'frozen',
  '3': 'expired',
  '4': 'locked',
  '9': 'inactivated',
};

export class PaySpaceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly requestSecret: string | undefined;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly topupPollAttempts: number;
  private readonly topupPollDelayMs: number;

  constructor(opts: PaySpaceClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.requestSecret = opts.requestSecret;
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.topupPollAttempts = opts.topupPollAttempts ?? DEFAULT_TOPUP_POLL_ATTEMPTS;
    this.topupPollDelayMs = opts.topupPollDelayMs ?? DEFAULT_TOPUP_POLL_DELAY_MS;
  }

  /** Выпуск новой карты (POST /vcc/card/create/). Стоит $4 fee + amount. */
  async createCard(input: CreateCardInput): Promise<CreateCardResult> {
    this.log.info({
      event: 'paypace.create_card.start',
      amountUsdCents: input.amountUsdCents,
    });
    const data = await this.request({
      method: 'POST',
      path: '/vcc/card/create/',
      body: {
        amount: usdCentsToDollarString(input.amountUsdCents),
        ...(input.expDate ? { expdate: input.expDate } : {}),
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      },
      schema: paySpaceCreateCardDataSchema,
      // createCard не шлёт request_id (провайдер не дедуплицирует выпуск) →
      // не ретраим, иначе повтор после таймаута выпустит вторую карту.
      idempotent: false,
    });
    const { card, network } = data;
    const { expMonth, expYear } = parseExpDate(card.exp_date);
    const result: CreateCardResult = {
      cardId: card.card_id,
      pan: card.card_no,
      panMasked: maskPan(card.card_no),
      expMonth,
      expYear,
      cvc: card.cvv,
      balanceUsdCents: dollarStringToUsdCents(card.balance),
      network,
    };
    this.log.info({
      event: 'paypace.create_card.ok',
      cardId: result.cardId,
      panMasked: result.panMasked, // маска — не полный PAN
      balanceUsdCents: result.balanceUsdCents,
    });
    return result;
  }

  /**
   * Пополнение карты (POST /vcc/card/topup/) — асинхронно. Submit возвращает
   * request_id+status; при `pending` поллим topup/check до подтверждения.
   * `requestId` делает повтор безопасным (идемпотентность провайдера).
   */
  async topupCard(input: TopupCardInput): Promise<TopupCardResult> {
    const submit = await this.request({
      method: 'POST',
      path: '/vcc/card/topup/',
      body: {
        card_id: input.cardId,
        amt: usdCentsToDollarString(input.amountUsdCents),
        request_id: input.requestId,
      },
      schema: paySpaceAsyncOpDataSchema,
    });

    if (submit.status === 'failed') {
      // Причину провайдер в ответе topup не передаёт (контракт = request_id +
      // status). Реальный диагноз даёт getCardInfo в issue-card. Логируем только
      // известные поля — инвариант: ничего недокументированного в Sentry.
      throw new PaySpaceApiError({
        code: 'topup_failed',
        httpStatus: 200,
        message: `topup failed (request_id=${submit.request_id})`,
      });
    }

    let status: PaySpaceAsyncOpStatus = submit.status;
    let balanceUsdCents: number | null = null;

    if (status === 'completed') {
      balanceUsdCents = await this.tryReadTopupBalance(input.cardId, submit.request_id);
    } else {
      // pending: поллим check; первый успешный ответ = деньги зачислены.
      for (let i = 0; i < this.topupPollAttempts; i++) {
        await this.sleepImpl(this.topupPollDelayMs);
        const bal = await this.tryReadTopupBalance(input.cardId, submit.request_id);
        if (bal !== null) {
          status = 'completed';
          balanceUsdCents = bal;
          break;
        }
      }
    }

    this.log.info({
      event: 'paypace.topup.result',
      cardId: input.cardId,
      requestId: submit.request_id,
      status,
      balanceUsdCents,
    });
    return { cardId: input.cardId, requestId: submit.request_id, status, balanceUsdCents };
  }

  /** Вывод средств с карты на VCC-баланс (POST /vcc/card/withdraw/). */
  async withdrawCard(input: WithdrawCardInput): Promise<PaySpaceAsyncOpStatus> {
    const submit = await this.request({
      method: 'POST',
      path: '/vcc/card/withdraw/',
      body: {
        card_id: input.cardId,
        amt: usdCentsToDollarString(input.amountUsdCents),
        request_id: input.requestId,
      },
      schema: paySpaceAsyncOpDataSchema,
    });
    this.log.info({
      event: 'paypace.withdraw.submitted',
      cardId: input.cardId,
      requestId: submit.request_id,
      status: submit.status,
    });
    return submit.status;
  }

  /** Закрытие карты (POST /vcc/card/release/) — НЕОБРАТИМО, остаток на VCC-баланс. */
  async releaseCard(cardId: string, requestId?: string): Promise<ReleaseCardResult> {
    const data = await this.request({
      method: 'POST',
      path: '/vcc/card/release/',
      body: { card_id: cardId, ...(requestId ? { request_id: requestId } : {}) },
      schema: paySpaceReleaseDataSchema,
    });
    this.log.info({ event: 'paypace.release.ok', cardId: data.cardId });
    return { cardId: data.cardId, releasedUsdCents: dollarStringToUsdCents(data.releaseBal) };
  }

  /** Инфо о карте (GET /vcc/card/info/). */
  async getCardInfo(cardId: string): Promise<CardInfoResult> {
    const data = await this.request({
      method: 'GET',
      path: '/vcc/card/info/',
      query: { card_id: cardId },
      schema: paySpaceCardInfoDataSchema,
    });
    return {
      cardId: data.cardId,
      panMasked: maskPan(data.cardNo),
      statusCode: data.status,
      statusLabel: CARD_STATUS_LABELS[data.status] ?? `unknown_${data.status}`,
      balanceUsdCents: dollarStringToUsdCents(data.cardBal),
      expDate: data.expDate,
      cardType: data.cardType ?? null,
      productCode: data.productCode ?? null,
    };
  }

  /**
   * Полные реквизиты карты (GET /vcc/card/info/) — номер/CVV/срок БЕЗ маски. В
   * отличие от `getCardInfo` ничего не маскирует: только для разового показа
   * клиенту по запросу. Возвращаемое НЕ логируем и не сохраняем (инвариант
   * безопасности). `request` тело ответа не логирует (только method/path).
   */
  async getCardSecrets(cardId: string): Promise<CardSecrets> {
    const data = await this.request({
      method: 'GET',
      path: '/vcc/card/info/',
      query: { card_id: cardId },
      schema: paySpaceCardInfoDataSchema,
    });
    return { cardNo: data.cardNo, cvv: data.cvv, expDate: data.expDate };
  }

  /** Баланс VCC-аккаунта (GET /vcc/user/balance/) — наш фонд под выпуск карт. */
  async getVccBalance(): Promise<VccBalanceResult> {
    const data = await this.request({
      method: 'GET',
      path: '/vcc/user/balance/',
      schema: paySpaceUserBalanceDataSchema,
    });
    return {
      balanceUsdCents: dollarStringToUsdCents(data.balance),
      pendingUsdCents: dollarStringToUsdCents(data.pending),
      currency: data.currency,
    };
  }

  // ─── низкоуровневое ─────────────────────────────────────────────────────

  /** topup/check: вернуть баланс карты (центы), либо null если ещё не зачислено. */
  private async tryReadTopupBalance(cardId: string, requestId: string): Promise<number | null> {
    try {
      const data = await this.request({
        method: 'GET',
        path: '/vcc/card/topup/check/',
        query: { card_id: cardId, request_id: requestId },
        schema: paySpaceTopupCheckDataSchema,
      });
      return dollarStringToUsdCents(data.total_amt);
    } catch (err) {
      // Контракт-дрифт пробрасываем, остальное (pending → ошибка/404) глушим.
      if (err instanceof PaySpaceContractError) throw err;
      return null;
    }
  }

  private async request<T>(opts: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown> | null;
    schema: z.ZodType<T>;
    /**
     * Идемпотентен ли запрос. По умолчанию `true` (GET по природе; topup/
     * withdraw/release идемпотентны через `request_id`). `false` — для операций,
     * которые провайдер не умеет дедуплицировать (createCard без request_id):
     * такие НЕ ретраим на таймаут/сбой, чтобы не выпустить вторую карту.
     */
    idempotent?: boolean;
  }): Promise<T> {
    const query = opts.query ?? {};
    const search = canonicalQuery(query);
    const url = `${this.baseUrl}${opts.path}${search ? `?${search}` : ''}`;
    const pathname = new URL(url).pathname;
    const bodyText = opts.method === 'GET' || !opts.body ? '' : JSON.stringify(opts.body);
    // Не-идемпотентный POST выполняем ровно один раз (без повторов на 5xx/сеть/
    // таймаут): повтор мог бы создать дубль-карту и потерять её фондирование.
    const maxAttempts = opts.idempotent === false ? 1 : MAX_RETRIES;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      this.log.debug({ event: 'paypace.request', method: opts.method, path: opts.path, attempt });

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
        };
        if (opts.method === 'POST') headers['Content-Type'] = 'application/json';
        if (this.requestSecret) {
          const signed = signPaySpaceRequest({
            method: opts.method,
            path: pathname,
            canonicalQuery: search,
            body: bodyText,
            requestSecret: this.requestSecret,
          });
          Object.assign(headers, signed);
        }

        const resp = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          body: opts.method === 'GET' ? undefined : bodyText,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const respText = await resp.text();
        let raw: unknown;
        try {
          raw = JSON.parse(respText);
        } catch {
          // не-JSON: на 5xx ретраим, иначе контракт-ошибка.
          if (isRetryableStatus(resp.status) && attempt < maxAttempts - 1) {
            await this.backoff(attempt, opts, resp.status);
            continue;
          }
          throw new PaySpaceContractError(resp.status, 'Non-JSON response', respText.slice(0, 500));
        }

        const env = envelopeSchema.safeParse(raw);
        if (!env.success) {
          throw new PaySpaceContractError(
            resp.status,
            `Нет поля success в ответе: ${env.error.message}`,
            respText.slice(0, 500),
          );
        }

        if (env.data.success) {
          const dataField = (raw as { data?: unknown }).data;
          try {
            return opts.schema.parse(dataField);
          } catch (err) {
            throw new PaySpaceContractError(
              resp.status,
              `Schema mismatch: ${(err as Error).message}`,
              respText.slice(0, 500),
            );
          }
        }

        // success === false → ошибка провайдера.
        const errParsed = paySpaceErrorSchema.safeParse((raw as { error?: unknown }).error);
        const code = errParsed.success ? errParsed.data.code : `HTTP_${resp.status}`;
        const message = errParsed.success ? errParsed.data.message : respText.slice(0, 500);

        if (isRetryableStatus(resp.status) && attempt < maxAttempts - 1) {
          await this.backoff(attempt, opts, resp.status);
          continue;
        }

        const apiErr = new PaySpaceApiError({ code, httpStatus: resp.status, message });
        this.log.error({
          event: 'paypace.error',
          method: opts.method,
          path: opts.path,
          code: apiErr.code,
          httpStatus: apiErr.httpStatus,
          message: apiErr.message,
        });
        throw apiErr;
      } catch (err) {
        clearTimeout(timeoutId);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const isNetwork = err instanceof TypeError && /fetch/i.test(err.message);
        const isContract = err instanceof PaySpaceContractError;
        if (!isContract && (isAbort || isNetwork) && attempt < maxAttempts - 1) {
          this.log.warn({
            event: 'paypace.retry',
            method: opts.method,
            path: opts.path,
            attempt,
            reason: isAbort ? 'timeout' : 'network',
          });
          lastError = err;
          await this.sleepImpl(1000 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('paypace: retries exhausted');
  }

  private async backoff(
    attempt: number,
    opts: { method: string; path: string },
    httpStatus: number,
  ): Promise<void> {
    const backoffMs = 1000 * Math.pow(2, attempt);
    this.log.warn({
      event: 'paypace.retry',
      method: opts.method,
      path: opts.path,
      attempt,
      httpStatus,
      backoffMs,
    });
    await this.sleepImpl(backoffMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
