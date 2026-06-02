/**
 * Узкие, типизированные ошибки Love & Pay-клиента.
 *
 * Кидаются вместо anonymous `new Error(...)` — call-site может `err instanceof
 * LoveAndPayApiError` и достать `code`/`httpStatus`/`requestId` без парсинга
 * сообщения.
 */

export class LoveAndPayApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly requestId: string | undefined;

  constructor(opts: { code: string; httpStatus: number; message: string; requestId?: string }) {
    super(opts.message);
    this.name = 'LoveAndPayApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.requestId = opts.requestId;
  }
}

/** Ошибка контракта — Zod-парсинг ответа провалился (контракт-дрифт). */
export class LoveAndPayContractError extends Error {
  readonly httpStatus: number;
  readonly rawBody: string;

  constructor(httpStatus: number, message: string, rawBody: string) {
    super(message);
    this.name = 'LoveAndPayContractError';
    this.httpStatus = httpStatus;
    this.rawBody = rawBody;
  }
}
