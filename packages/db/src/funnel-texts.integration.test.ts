import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import {
  listFunnelTextOverrides,
  listFunnelTextRevisions,
  listRecentFunnelTextRevisions,
  resetFunnelText,
  saveFunnelText,
} from './repositories/funnel-texts.ts';

/**
 * Тексты воронки (спека admin-panel-v2, тикет 09) — РЕАЛЬНЫЙ Postgres (PGlite)
 * с РЕАЛЬНЫМИ миграциями 0043/0044: append-only триггер истории и RLS иначе не
 * проверить.
 */

let db: DB;
let staffId: string;

beforeAll(async () => {
  ({ db } = await createTestDb());
  const rows = await db
    .insert(schema.staff)
    .values({ email: 'owner@example.com', displayName: 'Владелец', role: 'admin', telegramId: '1' })
    .returning({ id: schema.staff.id });
  staffId = rows[0]!.id;
});

describe('saveFunnelText / resetFunnelText', () => {
  it('первое сохранение: оверлей появился, ровно одна строка истории old=NULL → new', async () => {
    const res = await saveFunnelText(db, { key: 'expired_survey.body', value: 'Новый текст', staffId });

    expect(res).toEqual({ previous: null, current: 'Новый текст' });
    const overrides = await listFunnelTextOverrides(db);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      key: 'expired_survey.body',
      value: 'Новый текст',
      updatedBy: staffId,
      updatedByName: 'Владелец',
    });
    const history = await listFunnelTextRevisions(db, 'expired_survey.body');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ oldValue: null, newValue: 'Новый текст', staffName: 'Владелец' });
  });

  it('повторное сохранение того же значения — всё равно строка истории (факт действия)', async () => {
    await saveFunnelText(db, { key: 'expired_survey.body', value: 'Новый текст', staffId });

    const history = await listFunnelTextRevisions(db, 'expired_survey.body');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ oldValue: 'Новый текст', newValue: 'Новый текст' });
    expect(await listFunnelTextOverrides(db)).toHaveLength(1);
  });

  it('изменение значения: previous — прежний текст, история — новые сверху', async () => {
    const res = await saveFunnelText(db, { key: 'expired_survey.body', value: 'Третий', staffId });

    expect(res.previous).toBe('Новый текст');
    const history = await listFunnelTextRevisions(db, 'expired_survey.body');
    expect(history.map((h) => h.newValue)).toEqual(['Третий', 'Новый текст', 'Новый текст']);
  });

  it('сброс: оверлей удалён, история получила new_value NULL', async () => {
    const res = await resetFunnelText(db, { key: 'expired_survey.body', staffId });

    expect(res).toEqual({ changed: true, previous: 'Третий' });
    expect(await listFunnelTextOverrides(db)).toHaveLength(0);
    const history = await listFunnelTextRevisions(db, 'expired_survey.body');
    expect(history[0]).toMatchObject({ oldValue: 'Третий', newValue: null });
  });

  it('сброс без оверлея — идемпотентен, истории не пишется', async () => {
    const before = (await listFunnelTextRevisions(db, 'expired_survey.body')).length;

    const res = await resetFunnelText(db, { key: 'expired_survey.body', staffId });

    expect(res).toEqual({ changed: false, previous: null });
    expect(await listFunnelTextRevisions(db, 'expired_survey.body')).toHaveLength(before);
  });

  it('автор удалён — текст и история переживают, удаление сотрудника не блокируется', async () => {
    // У истории FK на staff нет намеренно: `ON DELETE SET NULL` — это UPDATE,
    // который append-only триггер отверг бы, и удаление сотрудника падало бы на
    // его правках. У оверлея FK есть (SET NULL) — он не append-only.
    const temp = await db
      .insert(schema.staff)
      .values({ email: 'temp@example.com', displayName: 'Временный', role: 'operator', telegramId: '2' })
      .returning({ id: schema.staff.id });
    const tempId = temp[0]!.id;
    await saveFunnelText(db, { key: 'common.thanks', value: 'Спасибо!', staffId: tempId });
    await db.execute(sql`DELETE FROM staff WHERE id = ${tempId}`);

    const overrides = await listFunnelTextOverrides(db);
    expect(overrides.find((o) => o.key === 'common.thanks')).toMatchObject({
      value: 'Спасибо!',
      updatedBy: null,
      updatedByName: null,
    });
    const history = await listFunnelTextRevisions(db, 'common.thanks');
    expect(history[0]).toMatchObject({ staffId: tempId, staffName: null, newValue: 'Спасибо!' });
  });

  it('limit истории клампится', async () => {
    for (let i = 0; i < 5; i++) {
      await saveFunnelText(db, { key: 'rating.low', value: `v${i}`, staffId });
    }
    expect(await listFunnelTextRevisions(db, 'rating.low', 2)).toHaveLength(2);
    expect(await listFunnelTextRevisions(db, 'rating.low', 0)).toHaveLength(1);
  });

  it('история по всем ключам одним запросом: новые сверху, включая ключ без живого оверлея', async () => {
    const all = await listRecentFunnelTextRevisions(db);
    const keys = new Set(all.map((r) => r.key));
    // `expired_survey.body` возвращён к дефолту выше — его история обязана остаться.
    expect(keys.has('expired_survey.body')).toBe(true);
    expect(keys.has('rating.low')).toBe(true);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(all[i]!.createdAt.getTime());
    }
    expect(await listRecentFunnelTextRevisions(db, 3)).toHaveLength(3);
  });
});

describe('инварианты БД', () => {
  it('UPDATE и DELETE строки истории бросают — append-only триггером', async () => {
    // drizzle оборачивает ошибку БД в DrizzleQueryError, оригинал Postgres — в cause.
    const causeMessage = (err: unknown) =>
      String((err as { cause?: { message?: string } })?.cause?.message ?? (err as Error).message);
    await expect(
      db.execute(sql`UPDATE funnel_text_revisions SET new_value = 'подделка'`).catch((e: unknown) => {
        throw new Error(causeMessage(e));
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.execute(sql`DELETE FROM funnel_text_revisions`).catch((e: unknown) => {
        throw new Error(causeMessage(e));
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('RLS включён на обеих таблицах', async () => {
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('funnel_texts', 'funnel_text_revisions')
    `);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
