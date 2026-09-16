/**
 * Узкие ошибки клиента FKWallet — по образцу `lib/freekassa/errors.ts`:
 * call-site различает их через `instanceof` и не парсит текст сообщения.
 */

export class FkWalletApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(opts: { code: string; httpStatus: number; message: string }) {
    super(opts.message);
    this.name = 'FkWalletApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
  }
}

/**
 * Ответ пришёл, но не той формы — контракт-дрейф (Zod не принял).
 *
 * `rawBody` — НЕПЕРЕЧИСЛЯЕМОЕ свойство (тот же приём, что у
 * `FreekassaContractError`): сырое тело ответа кошелька может нести реквизиты
 * и адреса, а ошибки сериализуются в pino и Sentry обходом собственных полей.
 */
export class FkWalletContractError extends Error {
  readonly httpStatus: number;
  readonly rawBody!: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'FkWalletContractError';
    this.httpStatus = httpStatus;
    Object.defineProperty(this, 'rawBody', {
      value: rawBody,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}
