import { isNetworkTypeError } from './client.ts';
import { LoveAndPayApiError } from './errors.ts';

/**
 * «Провайдер оплаты недоступен» vs «обычная ошибка» — чтобы при упавшем
 * прокси/L&P пользователь видел честное «технический сбой, попробуйте позже»,
 * а не generic-ошибку (пункт 3 правок аудита 2026-07-18, спутник H-3).
 *
 * Недоступность — это только транспорт/инфраструктура:
 *   - сетевой сбой fetch (лежит squid-прокси, DNS, соединение) — undici бросает
 *     `TypeError('fetch failed')`, а на обрыве сокета уже ПОСЛЕ заголовков —
 *     `TypeError('terminated')`; оба ловит `isNetworkTypeError`, клиент L&P
 *     после ретраев отдаёт их как есть;
 *   - таймаут (`AbortError` от AbortController);
 *   - 5xx/429 от самого L&P после ретраев.
 *
 * НЕ недоступность: 4xx (запрос отвергнут — провайдер жив) и контракт-дрейф
 * (ответ пришёл, но форма неожиданная — это баг интеграции, не сбой).
 */
export function isPaymentProviderUnavailable(err: unknown): boolean {
  if (err instanceof LoveAndPayApiError) {
    return err.httpStatus >= 500 || err.httpStatus === 429;
  }
  if (isNetworkTypeError(err)) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/** Единый пользовательский текст тех. сбоя оплаты — для всех каналов. */
export const PROVIDER_UNAVAILABLE_TEXT =
  'Оплата временно недоступна — у нас технический сбой. Заказ сохранён, попробуй снова через несколько минут.';
