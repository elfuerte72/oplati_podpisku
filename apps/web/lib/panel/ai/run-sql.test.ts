import { describe, expect, it, vi } from 'vitest';

import type { ReadOnlyQueryResult } from '@oplati/db';

const h = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import {
  executeRunSql,
  formatResultForModel,
  maskResultRows,
  stripSqlLiteralsAndComments,
  validateReadOnlySql,
} from './run-sql';

/**
 * Инструмент `run_sql` аналитика панели (тикет 05): страховки поверх роли —
 * одно выражение, только чтение; маска контактов в ячейках; формат для модели.
 * Сам исполнитель (read-only транзакция, потолки) проверен на PGlite в
 * `packages/db`; здесь он подменён через шов `query`.
 */

describe('validateReadOnlySql', () => {
  it('второе выражение через «;» отвергается', () => {
    const res = validateReadOnlySql('SELECT 1; DROP TABLE orders');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/одно выражение/);
  });

  it('точка с запятой в комментарии — не разделитель; завершающая снимается', () => {
    const res = validateReadOnlySql('/* ; */ SELECT 1;');
    expect(res).toEqual({ ok: true, sql: '/* ; */ SELECT 1' });
    expect(validateReadOnlySql('-- comment; here\nSELECT 2').ok).toBe(true);
  });

  it('«;» внутри строкового литерала — не разделитель', () => {
    expect(validateReadOnlySql("SELECT 'a;b' AS x").ok).toBe(true);
    expect(validateReadOnlySql("SELECT 'it''s; fine' AS x").ok).toBe(true);
    expect(validateReadOnlySql('SELECT $$a;b$$ AS x').ok).toBe(true);
  });

  it('WITH … SELECT проходит, скобки в начале тоже', () => {
    expect(validateReadOnlySql('WITH t AS (SELECT 1 AS a) SELECT a FROM t').ok).toBe(true);
    expect(validateReadOnlySql('(SELECT 1)').ok).toBe(true);
    expect(validateReadOnlySql('  select 1').ok).toBe(true);
  });

  it('не-SELECT отвергается: UPDATE, DELETE, INSERT, SET, EXPLAIN', () => {
    for (const sql of [
      "UPDATE orders SET status = 'x'",
      'DELETE FROM orders',
      'INSERT INTO orders VALUES (1)',
      'SET transaction_read_only = off',
      'EXPLAIN SELECT 1',
      'TRUNCATE orders',
    ]) {
      const res = validateReadOnlySql(sql);
      expect(res.ok, sql).toBe(false);
    }
  });

  it('блокировки, SELECT INTO, pg_sleep, COPY отвергаются', () => {
    expect(validateReadOnlySql('SELECT * FROM orders FOR UPDATE').ok).toBe(false);
    expect(validateReadOnlySql('select * from orders for no key update').ok).toBe(false);
    expect(validateReadOnlySql('SELECT * FROM orders FOR SHARE').ok).toBe(false);
    expect(validateReadOnlySql('SELECT * INTO tmp FROM orders').ok).toBe(false);
    expect(validateReadOnlySql('SELECT pg_sleep(10)').ok).toBe(false);
    expect(validateReadOnlySql("SELECT pg_sleep_for('1 hour')").ok).toBe(false);
    expect(validateReadOnlySql("SELECT pg_sleep_until(now())").ok).toBe(false);
    expect(validateReadOnlySql('SELECT lo_create(0)').ok).toBe(false);
    expect(validateReadOnlySql('COPY orders TO stdout').ok).toBe(false);
  });

  it('пустой запрос и одни комментарии — отказ', () => {
    expect(validateReadOnlySql('   ').ok).toBe(false);
    expect(validateReadOnlySql('-- nothing').ok).toBe(false);
  });

  it('stripSqlLiteralsAndComments гасит литералы и комментарии пробелами, сохраняя длину и код', () => {
    const src = "SELECT 'x;y' -- c;\nFROM t /* ; */";
    const out = stripSqlLiteralsAndComments(src);
    expect(out).toBe("SELECT '   '      \nFROM t        ");
    expect(out).toHaveLength(src.length);
  });

  it('хвостовой комментарий после «;» не прячет точку с запятой и не попадает в обёртку', () => {
    expect(validateReadOnlySql('SELECT count(*) FROM orders; -- total')).toEqual({
      ok: true,
      sql: 'SELECT count(*) FROM orders',
    });
    expect(validateReadOnlySql('SELECT 1 /* tail */')).toEqual({ ok: true, sql: 'SELECT 1' });
  });

  it('«$» внутри идентификатора — не долларовая строка: вторая команда за ним видна', () => {
    const payload = 'SELECT 1 AS x$a$) AS q; SELECT 2; SELECT * FROM (SELECT 1 AS y$a$';
    const res = validateReadOnlySql(payload);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/одно выражение/);
    expect(validateReadOnlySql('SELECT x$a$ FROM t').ok).toBe(true);
    // Идентификатор может быть кириллическим — `$` в нём тоже не долларовая строка.
    expect(validateReadOnlySql('SELECT 1 AS я$a$) AS q; SELECT 2').ok).toBe(false);
    expect(validateReadOnlySql("SELECT $tag$a;b$tag$ AS x").ok).toBe(true);
  });

  it("escape-строка E'\\'' закрывается там же, где у Postgres", () => {
    const payload = "SELECT E'\\'' AS q; DROP TABLE orders";
    expect(validateReadOnlySql(payload).ok).toBe(false);
    expect(validateReadOnlySql("SELECT E'a\\'b' AS x").ok).toBe(true);
    // Обычная строка: `\` — просто символ, `''` — кавычка.
    expect(validateReadOnlySql("SELECT 'a\\' AS x; SELECT 2").ok).toBe(false);
  });
});

describe('maskResultRows', () => {
  it('контакты в строковых ячейках маскируются, числа и uuid не трогаются', () => {
    const rows = maskResultRows([
      [
        'пишите на a@b.ru, +79991234567',
        123456789,
        '9b2e1c6a-0000-4000-8000-000000000001',
        null,
        // telegram_id текстом и uuid внутри свободного текста — идентификаторы,
        // а не PII: аналитик обязан указать на конкретного клиента.
        '7000000001',
        'заказ 9b2e1c6a-0000-4000-8000-000000000001 клиента +79991234567',
      ],
    ]);
    const cell = rows[0]?.[0] as string;
    expect(cell).toContain('[email]');
    expect(cell).toContain('[телефон]');
    expect(cell).not.toContain('a@b.ru');
    expect(rows[0]?.[1]).toBe(123456789);
    expect(rows[0]?.[2]).toBe('9b2e1c6a-0000-4000-8000-000000000001');
    expect(rows[0]?.[3]).toBeNull();
    expect(rows[0]?.[4]).toBe('7000000001');
    expect(rows[0]?.[5]).toBe('заказ 9b2e1c6a-0000-4000-8000-000000000001 клиента [телефон]');
  });

  it('jsonb-ячейка сериализуется и маскируется как строка — контакт внутри параметров заказа не уезжает', () => {
    const rows = maskResultRows([[{ accountEmail: 'a@b.ru', plan: 'premium' }]]);
    expect(rows[0]?.[0]).toBe('{"accountEmail":"[email]","plan":"premium"}');
  });
});

describe('formatResultForModel', () => {
  it('заголовок, строки через « | », итог с пометкой усечения', () => {
    const text = formatResultForModel({
      columns: ['day', 'amount'],
      rows: [
        ['2026-03-01', 100],
        ['2026-03-02', null],
      ],
      truncated: true,
    });
    expect(text).toBe('day | amount\n2026-03-01 | 100\n2026-03-02 | NULL\nrows: 2 (truncated)');
  });
});

describe('executeRunSql', () => {
  const ok = (rows: unknown[][], truncated = false): ReadOnlyQueryResult => ({
    ok: true,
    columns: ['id'],
    rows,
    truncated,
  });

  it('невалидный вход и не-SELECT не доходят до исполнителя, модель получает ошибку', async () => {
    const query = vi.fn();
    const bad = await executeRunSql({ nope: 1 }, { query });
    expect(bad.execution.isError).toBe(true);
    const upd = await executeRunSql({ sql: 'UPDATE orders SET status = 1' }, { query });
    expect(upd.execution.isError).toBe(true);
    expect(upd.view.error).toMatch(/SELECT/);
    expect(query).not.toHaveBeenCalled();
  });

  it('усечённый результат: текст для модели помечен, сырой объект — для экрана', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [i]);
    const query = vi.fn(async () => ok(rows, true));

    const out = await executeRunSql({ sql: 'SELECT id FROM orders;' }, { query });

    expect(query).toHaveBeenCalledWith(
      'SELECT id FROM orders',
      { rowLimit: 200, maxBytes: 32_768, timeoutMs: 30_000 },
      undefined,
    );
    expect(out.execution.isError).toBe(false);
    expect(String(out.execution.result)).toContain('rows: 200 (truncated)');
    expect(out.view).toMatchObject({ sql: 'SELECT id FROM orders', truncated: true, error: null });
    expect(out.view.rows).toHaveLength(200);
  });

  it('ошибка SQL уходит модели текстом Postgres как is_error — она поправит запрос', async () => {
    const query = vi.fn(async (): Promise<ReadOnlyQueryResult> => ({
      ok: false,
      reason: 'sql_error',
      message: 'column "amount" does not exist',
    }));

    const out = await executeRunSql({ sql: 'SELECT amount FROM orders' }, { query });

    expect(out.execution.isError).toBe(true);
    expect(out.execution.result).toMatchObject({
      error: 'ошибка SQL: column "amount" does not exist',
      reason: 'sql_error',
    });
    expect(out.view.error).toContain('does not exist');
  });

  it('значение ячейки в тексте ошибки Postgres маскируется как строки результата', async () => {
    const query = vi.fn(async (): Promise<ReadOnlyQueryResult> => ({
      ok: false,
      reason: 'sql_error',
      message: 'invalid input syntax for type integer: "ivan.petrov@example.com +7 999 123-45-67"',
    }));
    const out = await executeRunSql({ sql: 'SELECT custom_service_description::int FROM orders' }, { query });
    const text = JSON.stringify(out.execution.result);
    expect(text).not.toContain('ivan.petrov');
    expect(text).not.toContain('123-45-67');
    expect(text).toContain('[email]');
    expect(out.view.error).not.toContain('ivan.petrov');
  });

  it('недоступная база аналитика — connection: модель получает текст, Sentry — сигнал; sql_error Sentry не шумит', async () => {
    h.captureException.mockClear();
    const down = vi.fn(async (): Promise<ReadOnlyQueryResult> => ({
      ok: false,
      reason: 'connection',
      message: 'ECONNREFUSED',
    }));
    const out = await executeRunSql({ sql: 'SELECT 1' }, { query: down });
    expect(out.execution.isError).toBe(true);
    expect(out.view.errorReason).toBe('connection');
    expect(h.captureException).toHaveBeenCalledTimes(1);

    const bad = vi.fn(async (): Promise<ReadOnlyQueryResult> => ({ ok: false, reason: 'sql_error', message: 'x' }));
    await executeRunSql({ sql: 'SELECT 1' }, { query: bad });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('маска применяется к результату до отдачи модели и экрану', async () => {
    const query = vi.fn(async (): Promise<ReadOnlyQueryResult> => ({
      ok: true,
      columns: ['note'],
      rows: [['звоните +7 999 123-45-67']],
      truncated: false,
    }));

    const out = await executeRunSql({ sql: 'SELECT custom_service_description FROM orders' }, { query });

    expect(String(out.execution.result)).toContain('[телефон]');
    expect(String(out.execution.result)).not.toContain('999');
    expect(out.view.rows[0]?.[0]).toContain('[телефон]');
  });
});
