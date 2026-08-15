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
  /** Телефон плательщика E.164 (тикет 07); не передан → ключ не уходит вовсе. */
  tel?: string;
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
    return await this.serialized(async () => {
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
        // spread-условие, а не `tel: undefined`: ключ с undefined попал бы в
        // Object.keys подписи и разошёлся бы с JSON-телом (там его нет).
        ...(input.tel !== undefined ? { tel: input.tel } : {}),
      });

      // signature считается по params БЕЗ самого поля signature и добавляется
      // после — порядок как в PHP-эталоне доки.
      const body = { ...params, signature: signApiRequest(params, this.apiKey) };

      return await this.requestJson('/orders/create', body, (raw) =>
        freekassaCreateOrderResponseSchema.parse(raw),
      );
    }, FreekassaClient.QUEUE_WAIT_INTERACTIVE_MS);
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
    const resp = await this.serialized(async () => {
      const params = {
        shopId: this.shopId,
        nonce: await this.nonceProvider(),
        paymentId,
      };
      const body = { ...params, signature: signApiRequest(params, this.apiKey) };

      return await this.requestJson('/orders', body, (raw) =>
        freekassaOrdersResponseSchema.parse(raw),
      );
    }, FreekassaClient.QUEUE_WAIT_BACKGROUND_MS);
    // Фильтр по paymentId — на случай, если провайдер проигнорирует параметр и
    // отдаст первую страницу всех заказов: обработать чужой платёж как свой
    // было бы хуже, чем не обработать никакой.
    return resp.orders.find((o) => o.merchant_order_id === paymentId) ?? null;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Сколько ждём своей очереди, прежде чем сдаться.
   *
   * Интерактивный путь (`createOrder` из `payments/create`) отличается от
   * фонового: клиент стоит перед кнопкой «Оплатить», а самовызов
   * `confirm_order` обрывается на 45 с. Дождаться очереди дольше этого —
   * значит превратить ожидание в непонятный таймаут И оставить запрос
   * висеть: он выстрелит ПОСЛЕ обрыва и создаст у провайдера реальный
   * платёжный счёт без нашей строки `payments` (ровно тот призрак, ради
   * которого `createOrder` намеренно не ретраится). Поэтому ожидание
   * прерывается ДО отправки: nonce не тратится, запрос не уходит, клиент
   * получает штатное «технический сбой шлюза».
   */
  private static readonly QUEUE_WAIT_INTERACTIVE_MS = 10_000;
  /** Фоновым опросам (cron) спешить некуда — им важнее не потерять оплату. */
  private static readonly QUEUE_WAIT_BACKGROUND_MS = 60_000;

  /**
   * Очередь запросов к Freekassa: выдача nonce и отправка запроса — одна
   * критическая секция (аудит 2026-08-10).
   *
   * Провайдер требует nonce «всегда больше предыдущего»
   * (docs/reference/freekassa-api.md §6). Последовательность Postgres даёт
   * монотонную ВЫДАЧУ, но не порядок ПРИБЫТИЯ: два конкурентных запроса берут
   * N и N+1 и приезжают как попало — тот, что с меньшим номером, отвергается.
   * Раньше порядок держался тем, что единственный опрашивающий (`poll-payment`)
   * гнал Freekassa строго последовательно; с появлением второго потребителя
   * (`expire-payments`, чьё расписание совпадает с ним на :00/:15/:30/:45)
   * это перестало быть правдой.
   *
   * Очередь — на уровне клиента, а он lazy-синглтон процесса, поэтому её
   * достаточно при одной реплике (текущий контур: один контейнер Dokploy).
   * ⚠️ При масштабировании на две реплики понадобится межпроцессный замок
   * (`pg_advisory_lock`) — здесь он не взят намеренно: держать соединение из
   * пула на 10 подключений всё время HTTP-запроса к внешнему шлюзу опаснее,
   * чем сам разъезд nonce.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
    }, waitMs);

    const start = async (): Promise<T> => {
      clearTimeout(timer);
      if (expired) {
        // 503-семантика: шлюз (или очередь к нему) не отвечает вовремя.
        // Классифицируется `isFreekassaUnavailable` как транспортный сбой,
        // поэтому все каналы покажут «технический сбой, заказ сохранён».
        throw new FreekassaApiError({
          code: 'QUEUE_TIMEOUT',
          httpStatus: 503,
          message: `Freekassa: очередь запросов не освободилась за ${waitMs} мс`,
        });
      }
      return await fn();
    };

    // `then(start, start)` — очередь не должна вставать из-за упавшего
    // предыдущего запроса: его ошибку получает ЕГО вызывающий, следующий идёт
    // своим ходом.
    const run = this.chain.then(start, start);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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
