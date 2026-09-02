import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { PGlite } from '@electric-sql/pglite';

import type { DB } from './index.ts';
import { createTestDb, pgliteReadOnlyExecutor } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import * as schema from './schema.ts';
import { runReadOnlyQuery, type ReadOnlyExecutor } from './readonly-query.ts';

/**
 * Исполнитель read-only запросов аналитика панели (спека admin-panel-v2,
 * тикет 04). Роли `panel_ai_ro` в PGlite нет — тесты гоняют исполнитель через
 * обычное подключение харнеса и проверяют СТРАХОВКИ ИСПОЛНИТЕЛЯ: read-only
 * транзакцию, потолок строк, потолок объёма, классификацию ошибок. Они обязаны
 * держаться независимо от грантов — на проде это второй эшелон после роли.
 */

let db: DB;
let pg: PGlite;
let executor: ReadOnlyExecutor;

const OPTS = { rowLimit: 200, maxBytes: 32_768, timeoutMs: 30_000 };

beforeAll(async () => {
  ({ db, pg } = await createTestDb());
  executor = pgliteReadOnlyExecutor(pg);
  const user = await db
    .insert(schema.users)
    .values({ telegramId: 'ro-user' })
    .returning({ id: schema.users.id });
  const userId = user[0]!.id;
  for (let i = 0; i < 205; i++) {
    await createDraftOrder(db, {
      userId,
      status: 'draft',
      customServiceDescription: `ro-order-${i}`,
      amountRub: 100 * (i + 1),
    });
  }
});

describe('runReadOnlyQuery — страховки исполнителя', () => {
  it('SELECT проходит: колонки и строки массивами, без усечения', async () => {
    const res = await runReadOnlyQuery('SELECT 1 AS one, 2 AS two', OPTS, executor);

    expect(res).toMatchObject({ ok: true, columns: ['one', 'two'], truncated: false });
    if (res.ok) expect(res.rows).toEqual([[1, 2]]);
  });

  it('UPDATE и пишущий CTE отвергаются как ошибка SQL, данные не тронуты', async () => {
    // Третий эшелон: обёртка-подзапрос делает пишущее выражение синтаксически
    // невозможным — до транзакции и до грантов дело не доходит.
    const update = await runReadOnlyQuery("UPDATE orders SET status = 'cancelled'", OPTS, executor);
    expect(update).toMatchObject({ ok: false, reason: 'sql_error' });

    const cte = await runReadOnlyQuery(
      "WITH w AS (UPDATE orders SET status = 'cancelled' RETURNING id) SELECT count(*) FROM w",
      OPTS,
      executor,
    );
    expect(cte).toMatchObject({ ok: false, reason: 'sql_error' });

    const rows = await pg.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM orders WHERE status = 'cancelled'",
    );
    expect(rows.rows[0]?.cnt).toBe(0);
  });

  it('READ ONLY транзакция исполнителя отвергает запись даже без обёртки и без роли', async () => {
    // Второй эшелон, проверяется на самом исполнителе: сюда попадает запрос,
    // если обёртку когда-нибудь ослабят.
    await expect(
      executor.run("UPDATE orders SET status = 'cancelled'", 1_000),
    ).rejects.toMatchObject({ code: '25006' });
    const rows = await pg.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM orders WHERE status = 'cancelled'",
    );
    expect(rows.rows[0]?.cnt).toBe(0);
  });

  it('rowLimit: N+1 строк → truncated=true, отдано ровно N', async () => {
    const res = await runReadOnlyQuery(
      'SELECT id FROM orders ORDER BY created_at',
      { ...OPTS, rowLimit: 200 },
      executor,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(200);
      expect(res.truncated).toBe(true);
    }
  });

  it('ровно rowLimit строк — не усечено (честный признак, а не «упёрлись»)', async () => {
    const res = await runReadOnlyQuery(
      'SELECT id FROM orders ORDER BY created_at LIMIT 200',
      { ...OPTS, rowLimit: 200 },
      executor,
    );
    expect(res.ok && !res.truncated).toBe(true);
  });

  it('maxBytes режет длинную текстовую колонку и помечает усечение', async () => {
    const res = await runReadOnlyQuery(
      "SELECT repeat('x', 1000) AS blob FROM generate_series(1, 100)",
      { ...OPTS, maxBytes: 5_000 },
      executor,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(true);
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.rows.length).toBeLessThan(100);
    }
  });

  it('битый SQL → sql_error с текстом Postgres (модели он нужен, чтобы поправиться)', async () => {
    const res = await runReadOnlyQuery('SELECT * FROM no_such_table', OPTS, executor);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('sql_error');
      expect(res.message).toMatch(/no_such_table/);
    }
  });

  it('даты отдаются ISO-строками, а не объектами Date (результат уходит в JSON и в модель)', async () => {
    const res = await runReadOnlyQuery(
      "SELECT '2026-03-01T10:00:00Z'::timestamptz AS at",
      OPTS,
      executor,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0]?.[0]).toBe('2026-03-01T10:00:00.000Z');
  });

  it('без PANEL_AI_DATABASE_URL — not_configured, без попытки подключения', async () => {
    const prev = process.env.PANEL_AI_DATABASE_URL;
    delete process.env.PANEL_AI_DATABASE_URL;
    try {
      const res = await runReadOnlyQuery('SELECT 1', OPTS);
      expect(res).toEqual({
        ok: false,
        reason: 'not_configured',
        message: expect.stringContaining('PANEL_AI_DATABASE_URL'),
      });
    } finally {
      if (prev !== undefined) process.env.PANEL_AI_DATABASE_URL = prev;
    }
  });

  it('исполнитель, упавший не SQL-ошибкой, — connection; исполнитель никогда не бросает наружу', async () => {
    const broken: ReadOnlyExecutor = {
      run: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const res = await runReadOnlyQuery('SELECT 1', OPTS, broken);
    expect(res).toMatchObject({ ok: false, reason: 'connection' });
  });
});

describe('panel-ai-role.sql — канарейка грантов', () => {
  const sqlText = readFileSync(join(import.meta.dirname, '..', 'scripts', 'panel-ai-role.sql'), 'utf8');
  // Комментарии не считаются: файл ОБЯЗАН называть то, чего не делает.
  const statements = sqlText
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const grants = statements
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('GRANT'))
    .join(';\n');

  it('роль read-only и обходит RLS', () => {
    expect(statements).toContain('BYPASSRLS');
    expect(statements).toContain('default_transaction_read_only = on');
    expect(statements).toContain('CONNECTION LIMIT 2');
    expect(statements).not.toContain('ALTER DEFAULT PRIVILEGES');
  });

  it('переписка, вложения, токены привязки и сырая телеметрия не выдаются', () => {
    expect(grants).not.toMatch(/\bON messages\b/);
    expect(grants).not.toMatch(/\bON attachments\b/);
    expect(grants).not.toMatch(/\bON link_tokens\b/);
    expect(grants).not.toMatch(/\bON analytics_events\b/);
    expect(grants).toMatch(/\bON analytics_event_types\b/);
  });

  it('контакты, секреты и сырые снимки провайдера недостижимы по грантам', () => {
    // users — только перечисленные колонки, без email/phone/last_seen_ip.
    const usersGrant = grants.match(/GRANT SELECT \(([^)]+)\)\s+ON users/)?.[1] ?? '';
    expect(usersGrant).not.toMatch(/email|phone|last_seen_ip|display_name|web_session_id/);
    const paymentsGrant = grants.match(/GRANT SELECT \(([^)]+)\)\s+ON payments/s)?.[1] ?? '';
    expect(paymentsGrant).not.toMatch(/raw_payload/);
    const payoutsGrant = grants.match(/GRANT SELECT \(([^)]+)\)\s+ON referral_payouts/)?.[1] ?? '';
    expect(payoutsGrant).not.toMatch(/destination/);
    const staffGrant = grants.match(/GRANT SELECT \(([^)]+)\)\s+ON staff/)?.[1] ?? '';
    expect(staffGrant).not.toMatch(/totp|email|telegram_id/);
    const vpnGrant = grants.match(/GRANT SELECT \(([^)]+)\)\s+ON vpn_subscriptions/)?.[1] ?? '';
    expect(vpnGrant).not.toMatch(/subscription_url/);
    // Полного PAN в схеме нет вовсе; на всякий случай — и в грантах нет.
    expect(grants).not.toMatch(/\bpan\b|cvc/);
  });

  it('файл применяется к схеме: каждая таблица гранта существует в PGlite', async () => {
    const names = [...grants.matchAll(/\bON (\w+)\b/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== 'DATABASE' && n !== 'SCHEMA');
    const rows = await pg.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`,
    );
    const existing = new Set(rows.rows.map((r) => r.name));
    for (const name of names) expect(existing.has(name), name).toBe(true);
  });
});
