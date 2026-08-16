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
 * Провайдер отверг запрос из-за `nonce` («Request with same (or bigger) nonce
 * already exist»).
 *
 * Разбор по ТЕКСТУ сообщения — вынужденный и ровно в одном месте: своего кода у
 * этой ошибки нет (все отказы Freekassa приезжают одинаково — `type: "error"` +
 * HTTP 400), а отличать её необходимо. Это не «плохой запрос», а полный отказ
 * шлюза: счётчик nonce на стороне провайдера обогнал наш, и падает КАЖДОЕ
 * обращение, включая выставление счёта клиенту (инцидент 2026-08-15,
 * `docs/incidents.md`). Само лечение ручное — `setval` последовательности выше
 * значения провайдера, — поэтому единственная автоматика здесь это громкий
 * алёрт (`nonce-alert.ts`). Call-site'ы зовут предикат, а не парсят сообщение.
 */
export function isFreekassaNonceRejected(err: unknown): boolean {
  if (!(err instanceof FreekassaApiError)) return false;
  // Одного «nonce» мало: в ветке «не-`type:error` тело с плохим статусом»
  // (`client.ts`) сообщением становится СЫРОЕ тело провайдера, а в HTML любой
  // страницы-заглушки слово `nonce` встречается штатно (CSP-атрибут скрипта).
  // Ложный алёрт здесь дороже пропущенного: он зовёт владельца править счётчик
  // на живом шлюзе. Поэтому требуем и характерную часть фразы провайдера —
  // «Request with same (or bigger) nonce already exist».
  return /nonce/i.test(err.message) && /already exist|bigger/i.test(err.message);
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
