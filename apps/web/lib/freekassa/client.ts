import {
  freekassaCreateOrderParamsSchema,
  freekassaCreateOrderResponseSchema,
  freekassaErrorResponseSchema,
  freekassaOrdersResponseSchema,
  kopecksToRubleAmount,
  type FreekassaCreateOrderResponse,
  type FreekassaOrder,
} from '@oplati/types';

import type { Logger } from '../logger.ts';
import { FreekassaApiError, FreekassaContractError } from './errors.ts';
import { signApiRequest } from './sign.ts';

/**
 * HTTP-клиент Freekassa (<https://api.fk.life/v1>).
 *
 * Отличия от клиента L&P — осознанные, не небрежность:
 *
 *  - **Ретраев нет вообще.** `POST /orders/create` — мутирующая операция без
 *    идемпотентного ключа: повтор создаёт ВТОРОЙ заказ у провайдера. Плюс
 *    `nonce` обязан монотонно расти, то есть повтор с тем же телом провайдер
 *    отвергнет, а повтор со свежим nonce — это уже другой заказ. Сбой отдаём
 *    наверх: `payments/create` ответит `503 provider_unavailable`, платёж в БД
 *    не создан, заказ остался `ready_for_payment` — клиент жмёт «Оплатить» ещё
 *    раз и получает чистый новый заказ. Тот же вывод, что у PaySpace
 *    `createCard` (`idempotent: false`).
 *  - **Подпись в теле, а не в заголовках** (HMAC-SHA256 по отсортированным
 *    значениям, см. `./sign.ts`).
 *
 * `fetch` строго с `AbortController` (конвенция проекта). Дрейф контракта →
 * `FreekassaContractError`, отказ провайдера → `FreekassaApiError`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export type FreekassaClientOptions = {
  apiKey: string;
  shopId: number;
  baseUrl: string;
  logger: Logger;
  /**
   * Источник монотонного `nonce`. Инжектится (а не берётся из `@oplati/db`
   * внутри), чтобы клиент оставался тестируемым без базы; в проде это
   * `nextFreekassaNonce(getDb())` — последовательность Postgres.
   */
  nonceProvider: () => Promise<number>;
  /** Override fetch (для тестов / моков). */
  fetchImpl?: typeof fetch;
};

export type CreateOrderInput = {
  /** Наш идентификатор попытки оплаты; вернётся в уведомлении как `MERCHANT_ORDER_ID`. */
  paymentId: string;
  /** Сумма в КОПЕЙКАХ (инвариант 3); в рубли переводится ровно один раз, здесь. */
  amountKopecks: number;
  email: string;
  /** IP плательщика. `127.0.0.1` провайдер блокирует — см. `FREEKASSA_FALLBACK_IP`. */
  ip: string;
  /** Способ оплаты (`i`): 44 — СБП, 36 — карты РФ. */
  methodId: number;
  currency?: string;
};

export class FreekassaClient {
  private readonly apiKey: string;
  private readonly shopId: number;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly nonceProvider: () => Promise<number>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FreekassaClientOptions) {
    this.apiKey = opts.apiKey;
    this.shopId = opts.shopId;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.log = opts.logger;
    this.nonceProvider = opts.nonceProvider;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** `POST /orders/create` — создание заказа и получение ссылки на оплату. */
  async createOrder(input: CreateOrderInput): Promise<FreekassaCreateOrderResponse> {
    const nonce = await this.nonceProvider();

    // Zod и на исходящем теле (инвариант 5): мусорный email или нулевая сумма
    // должны падать у нас, а не превращаться в непрозрачный отказ провайдера.
    const params = freekassaCreateOrderParamsSchema.parse({
      shopId: this.shopId,
      nonce,
      paymentId: input.paymentId,
      i: input.methodId,
      email: input.email,
      ip: input.ip,
      amount: kopecksToRubleAmount(input.amountKopecks),
      currency: input.currency ?? 'RUB',
    });

    // signature считается по params БЕЗ самого поля signature и добавляется
    // после — порядок как в PHP-эталоне доки.
    const body = { ...params, signature: signApiRequest(params, this.apiKey) };

    return await this.requestJson('/orders/create', body, (raw) =>
      freekassaCreateOrderResponseSchema.parse(raw),
    );
  }

  /**
   * `POST /orders` — статус заказа по НАШЕМУ `paymentId` (у провайдера это
   * `MERCHANT_ORDER_ID`). Нужен добору потерянных уведомлений (cron
   * `poll-payment`): если провайдер говорит «оплачен», а у нас платёж всё ещё
   * `pending` — уведомление не дошло.
   *
   * Ищем по НАШЕМУ идентификатору, а не по `fk_order_id`: свой мы породили и в
   * нём уверены, а равенство `intid`/`orderId` докой не гарантировано. Бонусом
   * ответ содержит `fk_order_id` — по нему добор и покажет, совпадает ли он с
   * тем, что мы сохранили при создании счёта.
   *
   * Возвращает `null`, если заказа у провайдера нет (пустой список).
   */
  async findOrderByPaymentId(paymentId: string): Promise<FreekassaOrder | null> {
    const params = {
      shopId: this.shopId,
      nonce: await this.nonceProvider(),
      paymentId,
    };
    const body = { ...params, signature: signApiRequest(params, this.apiKey) };

    const resp = await this.requestJson('/orders', body, (raw) =>
      freekassaOrdersResponseSchema.parse(raw),
    );
    // Фильтр по paymentId — на случай, если провайдер проигнорирует параметр и
    // отдаст первую страницу всех заказов: обработать чужой платёж как свой
    // было бы хуже, чем не обработать никакой.
    return resp.orders.find((o) => o.merchant_order_id === paymentId) ?? null;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async requestJson<T>(
    path: string,
    body: Record<string, unknown>,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    this.log.info({ event: 'freekassa.request', path });

    const { resp, respText } = await this.fetchWithTimeout(url, body);

    let raw: unknown;
    try {
      raw = JSON.parse(respText);
    } catch (err) {
      throw new FreekassaContractError(
        resp.status,
        `Non-JSON response: ${(err as Error).message}`,
        respText,
      );
    }

    // Провайдер сигналит отказ полем `type: "error"`; HTTP-статус при этом
    // бывает и 200, и 400/401 — поэтому проверяем тело, а не только статус.
    const asError = freekassaErrorResponseSchema.safeParse(raw);
    if (asError.success) {
      const message =
        asError.data.message ?? asError.data.description ?? respText.slice(0, 500);
      const apiErr = new FreekassaApiError({
        code: `HTTP_${resp.status}`,
        httpStatus: resp.status,
        message,
      });
      this.log.error({
        event: 'freekassa.error',
        path,
        httpStatus: resp.status,
        message,
      });
      throw apiErr;
    }

    if (!resp.ok) {
      // Не-`type: error` тело с плохим статусом: отдаём как ошибку API с
      // обрезанным телом, чтобы не терять диагностику.
      throw new FreekassaApiError({
        code: `HTTP_${resp.status}`,
        httpStatus: resp.status,
        message: respText.slice(0, 500),
      });
    }

    try {
      const parsed = parse(raw);
      this.log.info({ event: 'freekassa.response.ok', path, status: resp.status });
      return parsed;
    } catch (err) {
      throw new FreekassaContractError(
        resp.status,
        `Response schema mismatch: ${(err as Error).message}`,
        respText,
      );
    }
  }

  /** `fetch` + чтение тела под общим таймаутом; таймер гасится всегда. */
  private async fetchWithTimeout(
    url: string,
    body: Record<string, unknown>,
  ): Promise<{ resp: Response; respText: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const respText = await resp.text();
      return { resp, respText };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
