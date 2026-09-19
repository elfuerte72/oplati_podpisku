import { describe, expect, it } from 'vitest';

import { isFreekassaUnavailable } from './availability.ts';
import { FreekassaApiError, FreekassaContractError } from './errors.ts';

function apiError(httpStatus: number, message = 'boom'): FreekassaApiError {
  return new FreekassaApiError({ code: `HTTP_${httpStatus}`, httpStatus, message });
}

describe('isFreekassaUnavailable — отказ по существу против лежащего шлюза', () => {
  it('5xx и 429 самого шлюза — недоступность', () => {
    expect(isFreekassaUnavailable(apiError(500))).toBe(true);
    expect(isFreekassaUnavailable(apiError(502))).toBe(true);
    expect(isFreekassaUnavailable(apiError(503))).toBe(true);
    expect(isFreekassaUnavailable(apiError(429))).toBe(true);
  });

  it('очередь клиента не освободилась (`QUEUE_TIMEOUT`, 503) — недоступность', () => {
    // Своя 503-семантика клиента: запрос даже не ушёл, а клиенту всё равно
    // положен текст «технический сбой, заказ сохранён».
    expect(
      isFreekassaUnavailable(
        new FreekassaApiError({
          code: 'QUEUE_TIMEOUT',
          httpStatus: 503,
          message: 'Freekassa: очередь запросов не освободилась за 10000 мс',
        }),
      ),
    ).toBe(true);
  });

  it('4xx — НЕ недоступность: шлюз жив и отверг запрос', () => {
    expect(isFreekassaUnavailable(apiError(400, 'amount too small'))).toBe(false);
    expect(isFreekassaUnavailable(apiError(401))).toBe(false);
    expect(isFreekassaUnavailable(apiError(404))).toBe(false);
  });

  it('отказ по `nonce` (400) остаётся «отказал», а не «недоступен»', () => {
    // Граница намеренная: лечение ручное (`setval`), и подменять его на
    // «попробуй позже» нельзя — клиент будет жать кнопку в пустоту. Перенос
    // этого случая в недоступность — решение владельца (docs/BACKLOG.md).
    expect(
      isFreekassaUnavailable(apiError(400, 'Request with same (or bigger) nonce already exist')),
    ).toBe(false);
  });

  it('тело не JSON ПРИ 5xx — недоступность, а не баг интеграции', () => {
    // Регресс инцидента 2026-09-17: Freekassa отдала HTML-страницу
    // «502 Bad Gateway», клиент назвал это дрейфом контракта, и путь
    // выставления счёта ответил бы клиенту `500` вместо честного `503`.
    const err = new FreekassaContractError(
      502,
      `Non-JSON response: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
      '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
    );
    expect(isFreekassaUnavailable(err)).toBe(true);
  });

  it('дрейф контракта на 2xx — НЕ недоступность: «позже» его не вылечит', () => {
    expect(
      isFreekassaUnavailable(
        new FreekassaContractError(200, 'Response schema mismatch: orders', '{"orders":null}'),
      ),
    ).toBe(false);
    expect(
      isFreekassaUnavailable(
        new FreekassaContractError(400, 'Non-JSON response: unexpected end', 'oops'),
      ),
    ).toBe(false);
  });

  it('сырое тело шлюза не перечисляемо — недоступность его не раскрывает', () => {
    // Классификация читает только статус: `rawBody` остаётся скрытым от
    // сериализаторов pino/Sentry, ради чего тип ошибки и не менялся.
    const err = new FreekassaContractError(502, 'Non-JSON response: x', '<!DOCTYPE html>');
    expect(isFreekassaUnavailable(err)).toBe(true);
    expect(Object.keys(err)).not.toContain('rawBody');
    expect(JSON.stringify(err)).not.toContain('DOCTYPE');
  });

  it('чужие ошибки не классифицируются', () => {
    expect(isFreekassaUnavailable(new Error('fetch failed'))).toBe(false);
    expect(isFreekassaUnavailable(null)).toBe(false);
    expect(isFreekassaUnavailable(undefined)).toBe(false);
    expect(isFreekassaUnavailable({ httpStatus: 502 })).toBe(false);
  });
});
