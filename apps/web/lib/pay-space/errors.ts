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
  readonly rawBody: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'PaySpaceContractError';
    this.httpStatus = httpStatus;
    this.rawBody = rawBody;
  }
}
