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

/** Ответ пришёл, но не той формы — контракт-дрейф (Zod не принял). */
export class FreekassaContractError extends Error {
  readonly httpStatus: number;
  readonly rawBody: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'FreekassaContractError';
    this.httpStatus = httpStatus;
    this.rawBody = rawBody;
  }
}
