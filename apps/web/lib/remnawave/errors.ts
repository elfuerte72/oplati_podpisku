/**
 * Типизированные ошибки клиента Remnawave (панель VPN-подписок).
 * Разделение как у PaySpace/L&P: HTTP-ошибка API (статус известен, можно
 * ветвиться — например 404 при revoke удалённого вручную юзера) против
 * дрейфа контракта (тело не прошло Zod — интеграция требует внимания).
 */

export class RemnawaveApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RemnawaveApiError';
    this.status = status;
  }
}

export class RemnawaveContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemnawaveContractError';
  }
}
