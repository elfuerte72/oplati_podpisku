import { FreekassaApiError } from './errors.ts';

/**
 * «Freekassa недоступна» vs «Freekassa отказала» — та же граница, что у L&P
 * (`lib/loveandpay/availability.ts`): недоступность это ТОЛЬКО транспорт и
 * 5xx/429 самого шлюза. Общий транспорт (сетевой сбой `fetch`, `AbortError`)
 * уже классифицирует L&P-детектор, поэтому здесь — только своя типизированная
 * ошибка; агрегатор для обоих провайдеров — `lib/payments/availability.ts`.
 *
 * НЕ недоступность: 4xx (`{"type":"error"}` — шлюз жив и отверг запрос) и
 * контракт-дрейф (`FreekassaContractError` — ответ пришёл, форма неожиданная;
 * это баг интеграции, «попробуйте позже» его не вылечит).
 */
export function isFreekassaUnavailable(err: unknown): boolean {
  if (err instanceof FreekassaApiError) {
    return err.httpStatus >= 500 || err.httpStatus === 429;
  }
  return false;
}
