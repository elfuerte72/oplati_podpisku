import { FreekassaApiError, FreekassaContractError } from './errors.ts';

/**
 * «Freekassa недоступна» vs «Freekassa отказала» — та же граница, что у L&P
 * (`lib/loveandpay/availability.ts`): недоступность это ТОЛЬКО транспорт и
 * 5xx/429 самого шлюза. Общий транспорт (сетевой сбой `fetch`, `AbortError`)
 * уже классифицирует L&P-детектор, поэтому здесь — только свои типизированные
 * ошибки; агрегатор для обоих провайдеров — `lib/payments/availability.ts`.
 *
 * ⚠️ Решает СТАТУС, а не тип ошибки — в отличие от L&P, где хватает одного
 * `LoveAndPayApiError`. Причина в порядке проверок внутри клиентов: L&P парсит
 * JSON только на `resp.ok`, а Freekassa — ДО проверки статуса (`sendJson`),
 * поэтому 5xx с HTML-заглушкой балансировщика приезжает как
 * `FreekassaContractError`, хотя дрейфа контракта в нём нет: шлюз просто лёг
 * (инцидент 2026-09-17 — `502` и страница «Bad Gateway» на `POST /orders`
 * после 10 с ожидания). Считать это «багом интеграции» значило бы отдать
 * клиенту `500 internal_error` вместо `503` с текстом «технический сбой, заказ
 * сохранён, попробуй позже» — при том что «позже» тут как раз лечит.
 *
 * Тип ошибки при этом НЕ меняется (`sendJson` не тронут): `rawBody` у
 * контракт-ошибки неперечисляемое и redact'ится логгером, а сообщение
 * стабильно — сырое HTML-тело шлюза не должно ни уезжать в Sentry, ни ломать
 * группировку issue своей уникальностью.
 *
 * НЕ недоступность: 4xx (`{"type":"error"}` — шлюз жив и отверг запрос, включая
 * отказ по `nonce`) и дрейф контракта на 2xx (ответ по существу пришёл, форма
 * неожиданная — «попробуйте позже» такое не вылечит).
 */
export function isFreekassaUnavailable(err: unknown): boolean {
  if (err instanceof FreekassaApiError || err instanceof FreekassaContractError) {
    return isUnavailableStatus(err.httpStatus);
  }
  return false;
}

/**
 * Порог один на оба типа ошибки, потому что вопрос один: «шлюз ответил по
 * существу или отказала инфраструктура?». Держать два списка статусов значило
 * бы завести зеркало внутри одной функции.
 */
function isUnavailableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
