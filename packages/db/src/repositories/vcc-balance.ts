import { eq } from 'drizzle-orm';

import { vccBalanceSnapshots } from '../schema.ts';
import type { DBLike } from '../index.ts';

/**
 * Снимок остатка карточного фонда: пишет крон опроса баланса, читает гейт
 * оплаты (`.scratch/vcc-preflight/`, тикет 03).
 *
 * Разбор «почему снимка достаточно» — в комментарии к таблице `schema.ts`.
 */

/**
 * Ключ строки снимка. Зеркалом не является: и писатель (крон опроса баланса), и
 * читатель (гейт оплаты) берут значение ОТСЮДА.
 */
export const VCC_SNAPSHOT_PROVIDER = 'payspace';

export type VccBalanceSnapshot = {
  provider: string;
  balanceUsdCents: number;
  pendingUsdCents: number;
  /** Момент ОПРОСА провайдера (не записи в базу) — по нему считается свежесть. */
  readAt: Date;
};

/**
 * Записать увиденный баланс. Перезапись, а не вставка: строка на провайдера
 * одна, и историю здесь никто не читает.
 */
export async function saveVccBalanceSnapshot(
  db: DBLike,
  input: VccBalanceSnapshot,
): Promise<void> {
  await db
    .insert(vccBalanceSnapshots)
    .values({
      provider: input.provider,
      balanceUsdCents: input.balanceUsdCents,
      pendingUsdCents: input.pendingUsdCents,
      readAt: input.readAt,
    })
    .onConflictDoUpdate({
      target: vccBalanceSnapshots.provider,
      set: {
        balanceUsdCents: input.balanceUsdCents,
        pendingUsdCents: input.pendingUsdCents,
        readAt: input.readAt,
      },
    });
}

/**
 * Последнее известное значение или `null`, если крон ещё ни разу не отработал.
 *
 * ⚠️ Именно `null`, а не ноль: ноль означал бы «денег нет» и заблокировал бы
 * все оплаты сразу после выката, до первого прогона крона.
 */
export async function getVccBalanceSnapshot(
  db: DBLike,
  provider: string,
): Promise<VccBalanceSnapshot | null> {
  const rows = await db
    .select()
    .from(vccBalanceSnapshots)
    .where(eq(vccBalanceSnapshots.provider, provider))
    .limit(1);

  const row = rows[0];
  return row
    ? {
        provider: row.provider,
        balanceUsdCents: row.balanceUsdCents,
        pendingUsdCents: row.pendingUsdCents,
        readAt: row.readAt,
      }
    : null;
}
