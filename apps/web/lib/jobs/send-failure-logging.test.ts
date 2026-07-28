import { describe, expect, it } from 'vitest';
import { GrammyError } from 'grammy';

import { redactPaths } from '../logger.ts';

/**
 * Регресс аудита 2026-07-28 (BLOCKER): реквизиты карты уезжали в логи через
 * ошибку отправки Telegram.
 *
 * Сообщение о выпуске карты содержит полный PAN и CVC. grammY кладёт ТЕЛО
 * запроса в `GrammyError.payload` — это ПЕРЕЧИСЛЯЕМОЕ свойство, поэтому
 * `pino-std-serializers` копирует его вместе с ошибкой (`for (const key in err)`),
 * и `log.error({ err })` печатал реквизиты в stdout → docker json-file → Loki.
 * Достаточно было, чтобы Telegram ответил 403 (клиент заблокировал бота),
 * 400 или 429 сразу после оплаты.
 *
 * Защита двухслойная, тест проверяет ОБА слоя:
 *  1. код не логирует такую ошибку целиком (`logSendFailure` в issue-card.ts);
 *  2. redact-пути логгера покрывают вложенность `err.payload.text`.
 */

function makeGrammyErrorWithCardData(): GrammyError {
  // Форма, в которой ошибка реально приходит из grammY: payload — тело вызова
  // sendMessage, то есть текст сообщения с реквизитами.
  return Object.assign(Object.create(GrammyError.prototype) as GrammyError, {
    name: 'GrammyError',
    message: 'Call to sendMessage failed! (403: Forbidden: bot was blocked by the user)',
    error_code: 403,
    description: 'Forbidden: bot was blocked by the user',
    payload: {
      chat_id: 12345,
      text: 'Карта: 4111 1111 1111 1111\nCVC: 123\nСрок: 12/28',
      parse_mode: 'HTML',
    },
  });
}

describe('redact-пути логгера покрывают тело запроса grammY', () => {
  it('`*.payload.text` объявлен — иначе PAN из err.payload.text уедет в логи', () => {
    // Путь `*.text` (он был раньше) имеет глубину 2 и до err.payload.text НЕ достаёт.
    expect(redactPaths).toContain('*.payload.text');
    expect(redactPaths).toContain('err.payload');
  });

  it('payload действительно перечисляемый — то есть проблема не теоретическая', () => {
    const err = makeGrammyErrorWithCardData();
    const serializedKeys = Object.keys(err);
    expect(serializedKeys).toContain('payload');
    // Именно поэтому нельзя писать log.error({ err }) там, где в payload реквизиты.
    expect(JSON.stringify(err)).toContain('4111');
  });
});

describe('issue-card: сбой отправки логируется без тела запроса', () => {
  it('в лог идут только error_code и description', async () => {
    // Читаем исходник: unit-тест самой функции потребовал бы поднять весь модуль
    // с БД и PaySpace, а гарантия здесь — текстовая и однозначная.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./issue-card.ts', import.meta.url), 'utf8'),
    );

    // Обе ветки отправки клиенту используют безопасный хелпер.
    expect(src).toContain("logSendFailure('job.issue_card.send_credentials.failed'");
    expect(src).toContain("logSendFailure('job.issue_card.topup_notice.failed'");
    // И ни одна из них не логирует ошибку целиком.
    expect(src).not.toContain("event: 'job.issue_card.send_credentials.failed', shortId: args.serviceShortId, err");
    expect(src).not.toContain("event: 'job.issue_card.topup_notice.failed', shortId: args.serviceShortId, err");
    // В Sentry уходит плоская ошибка без payload.
    expect(src).toContain('sanitizeSendError(err)');
  });
});
