/**
 * Узкие, типизированные ошибки app.pay.space.
 */

export class PaySpaceApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(opts: { code: string; httpStatus: number; message: string }) {
    super(opts.message);
    this.name = 'PaySpaceApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
  }
}

export class PaySpaceContractError extends Error {
  readonly httpStatus: number;
  /**
   * Сырое тело ответа провайдера (обрезанное). Для card-эндпоинтов оно содержит
   * полный PAN/CVV, поэтому свойство определяется НЕперечисляемым: доступно
   * программно (`err.rawBody` для отладки), но НЕ попадает в перечисление
   * enumerable-свойств, которое делают сериализаторы pino (`log.error({ err })`)
   * и Sentry (`captureException(err)`). Инвариант: PAN/CVC никогда не в логи/Sentry.
   */
  declare readonly rawBody: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'PaySpaceContractError';
    this.httpStatus = httpStatus;
    Object.defineProperty(this, 'rawBody', {
      value: rawBody,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}
