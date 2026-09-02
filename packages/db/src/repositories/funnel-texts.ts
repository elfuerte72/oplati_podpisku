import { desc, eq } from 'drizzle-orm';

import { funnelTextRevisions, funnelTexts, staff } from '../schema.ts';
import type { DB } from '../index.ts';

/**
 * Тексты воронки обратной связи — оверлей над дефолтами из кода (спека
 * `.scratch/admin-panel-v2/`, ветка C, тикет 09).
 *
 * Дефолты живут в `apps/web/lib/telegram/templates.ts`, реестр ключей — в
 * `apps/web/lib/funnel/texts.ts`; здесь — ТОЛЬКО хранение переопределений и
 * истории. Ключ — свободный текст: `packages/db` о реестре не знает (границы
 * пакетов), валидация ключа и подстановок — на стороне приложения.
 *
 * Сохранение и сброс пишут строку истории В ТОЙ ЖЕ транзакции, что и оверлей:
 * «кто, когда, что было» — это часть действия, а не журнал вдогонку. История
 * append-only триггером (миграция 0044).
 */

export type FunnelTextOverride = {
  key: string;
  value: string;
  updatedAt: Date;
  updatedBy: string | null;
  /** Имя сотрудника — для пометки «изменено» на экране. `null` — автор удалён. */
  updatedByName: string | null;
};

/** Все переопределения — их не больше, чем ключей в реестре (десятки). */
export async function listFunnelTextOverrides(db: DB): Promise<FunnelTextOverride[]> {
  return db
    .select({
      key: funnelTexts.key,
      value: funnelTexts.value,
      updatedAt: funnelTexts.updatedAt,
      updatedBy: funnelTexts.updatedBy,
      updatedByName: staff.displayName,
    })
    .from(funnelTexts)
    .leftJoin(staff, eq(staff.id, funnelTexts.updatedBy))
    .orderBy(funnelTexts.key);
}

export type SaveFunnelTextResult = {
  /** Прежнее переопределение; `null` — до этого действовал дефолт. */
  previous: string | null;
  current: string;
};

/**
 * Сохранить переопределение. Одна транзакция: лок текущей строки, upsert,
 * строка истории с `old_value`/`new_value`. Повторное сохранение того же
 * значения тоже пишет историю — это факт действия сотрудника, а не дифф.
 */
export async function saveFunnelText(
  db: DB,
  input: { key: string; value: string; staffId: string | null },
): Promise<SaveFunnelTextResult> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ value: funnelTexts.value })
      .from(funnelTexts)
      .where(eq(funnelTexts.key, input.key))
      .for('update')
      .limit(1);
    const previous = current[0]?.value ?? null;

    await tx
      .insert(funnelTexts)
      .values({ key: input.key, value: input.value, updatedBy: input.staffId })
      .onConflictDoUpdate({
        target: funnelTexts.key,
        set: { value: input.value, updatedBy: input.staffId, updatedAt: new Date() },
      });

    await tx.insert(funnelTextRevisions).values({
      key: input.key,
      oldValue: previous,
      newValue: input.value,
      staffId: input.staffId,
    });

    return { previous, current: input.value };
  });
}

/**
 * Вернуть дефолт: удалить переопределение и записать в историю `new_value NULL`.
 * Идемпотентно — без строки оверлея ничего не пишется (`changed: false`):
 * повторный клик не плодит записей о «возврате», которого не было.
 */
export async function resetFunnelText(
  db: DB,
  input: { key: string; staffId: string | null },
): Promise<{ changed: boolean; previous: string | null }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(funnelTexts)
      .where(eq(funnelTexts.key, input.key))
      .returning({ value: funnelTexts.value });
    const previous = deleted[0]?.value;
    if (previous === undefined) return { changed: false, previous: null };

    await tx.insert(funnelTextRevisions).values({
      key: input.key,
      oldValue: previous,
      newValue: null,
      staffId: input.staffId,
    });
    return { changed: true, previous };
  });
}

export type FunnelTextRevision = {
  id: string;
  key: string;
  oldValue: string | null;
  /** `null` — возврат к дефолту из кода. */
  newValue: string | null;
  staffId: string | null;
  staffName: string | null;
  createdAt: Date;
};

/** История правок ключа, новые сверху. */
export async function listFunnelTextRevisions(
  db: DB,
  key: string,
  limit = 20,
): Promise<FunnelTextRevision[]> {
  return db
    .select({
      id: funnelTextRevisions.id,
      key: funnelTextRevisions.key,
      oldValue: funnelTextRevisions.oldValue,
      newValue: funnelTextRevisions.newValue,
      staffId: funnelTextRevisions.staffId,
      staffName: staff.displayName,
      createdAt: funnelTextRevisions.createdAt,
    })
    .from(funnelTextRevisions)
    .leftJoin(staff, eq(staff.id, funnelTextRevisions.staffId))
    .where(eq(funnelTextRevisions.key, key))
    .orderBy(desc(funnelTextRevisions.createdAt), desc(funnelTextRevisions.id))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 100));
}
