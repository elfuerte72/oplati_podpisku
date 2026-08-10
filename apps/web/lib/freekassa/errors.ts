/**
 * Узкие ошибки Freekassa-клиента — по образцу `lib/loveandpay/errors.ts`:
 * call-site различает их через `instanceof` и не парсит текст сообщения.
 */

export class FreekassaApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(opts: { code: string; httpStatus: number; message: string }) {
    super(opts.message);
    this.name = 'FreekassaApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
  }
}

/**
 * Ответ пришёл, но не той формы — контракт-дрейф (Zod не принял).
 *
 * `rawBody` — НЕПЕРЕЧИСЛЯЕМОЕ свойство (аудит 2026-08-10, тот же приём, что у
 * `PaySpaceContractError`). Сырое тело ответа платёжного шлюза при дрейфе
 * контракта может содержать реквизиты плательщика, а ошибки сериализуются в
 * pino и Sentry обходом собственных полей — перечисляемое поле уехало бы туда
 * целиком. Для отладки оно доступно как обычно (`err.rawBody`), логгер
 * дополнительно redact'ит `err.rawBody`/`*.rawBody`.
 */
export class FreekassaContractError extends Error {
  readonly httpStatus: number;
  readonly rawBody!: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'FreekassaContractError';
    this.httpStatus = httpStatus;
    Object.defineProperty(this, 'rawBody', {
      value: rawBody,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}
