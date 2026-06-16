import { and, eq, sql } from 'drizzle-orm';

import { cards } from '../schema.ts';
import type { DB } from '../index.ts';
import type { CardStatus } from '@oplati/types';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий виртуальных USD-карт (app.pay.space). Карты создаются `issue-card`
 * job-ом после успешной оплаты, переиспользуются между заказами одного пользователя,
 * переводятся в `idle` после 90 дней простоя и далее в `recycled` через 180 дней —
 * откуда могут быть выданы другому пользователю (см. план Task 6.6).
 *
 * Все суммы — USD-центы (`balance_usd_cents integer`); никогда не numeric/float.
 */

export type Card = {
  id: string;
  userId: string;
  provider: string;
  providerCardId: string;
  panMasked: string;
  status: CardStatus;
  balanceUsdCents: number;
  lastUsedAt: Date | null;
  recycledAt: Date | null;
  createdAt: Date;
};

export type CreateCardInput = {
  userId: string;
  providerCardId: string;
  panMasked: string;
  provider?: string;
  balanceUsdCents?: number;
};

export async function createCard(
  db: DB,
  input: CreateCardInput,
  log: RepoLogger = noopLogger,
): Promise<Card> {
  const { userId, providerCardId, panMasked, provider = 'paypace', balanceUsdCents = 0 } = input;

  const inserted = await db
    .insert(cards)
    .values({
      userId,
      providerCardId,
      panMasked,
      provider,
      balanceUsdCents,
      status: 'active',
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new Error('createCard: INSERT не вернул строку');
  }

  log.info({
    event: 'db.cards.created',
    cardId: row.id,
    userId,
    provider,
    panMasked,
    balanceUsdCents,
  });

  return mapRowToCard(row);
}

/**
 * Активная карта пользователя — для переиспользования в новом заказе (top-up
 * вместо выпуска новой). Если у пользователя несколько активных, возвращаем
 * самую свежую (LIFO — последняя выпущенная).
 */
export async function findActiveByUserId(db: DB, userId: string): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.status, 'active')))
    .orderBy(sql`${cards.createdAt} DESC`)
    .limit(1);

  const row = rows[0];
  return row ? mapRowToCard(row) : null;
}

/**
 * Карты пользователя для личного кабинета (Mini App): только `active` и `idle`.
 * `recycled` скрываем — такая карта могла быть переназначена другому владельцу,
 * показывать её прежнему клиенту нельзя. Свежие первыми. Read-only.
 */
export async function findCardsByUserIdForCabinet(db: DB, userId: string): Promise<Card[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), sql`${cards.status} IN ('active', 'idle')`))
    .orderBy(sql`${cards.createdAt} DESC`);
  return rows.map(mapRowToCard);
}

/**
 * Recycled-карта для повторного использования: status='recycled' (см. `recycle-cards`
 * cron). Берём первую попавшуюся; в issue-card job переписываем userId на нового
 * владельца и переводим в active.
 */
export async function findRecyclableCard(
  db: DB,
  log: RepoLogger = noopLogger,
): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(eq(cards.status, 'recycled'))
    .orderBy(sql`${cards.createdAt} ASC`)
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  log.info({
    event: 'db.cards.recyclable_found',
    cardId: row.id,
    panMasked: row.panMasked,
  });

  return mapRowToCard(row);
}

export async function markIdle(
  db: DB,
  cardId: string,
  lastUsedAt: Date,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db
    .update(cards)
    .set({ status: 'idle', lastUsedAt })
    .where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.marked_idle', cardId, lastUsedAt: lastUsedAt.toISOString() });
}

export async function markRecycled(
  db: DB,
  cardId: string,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db
    .update(cards)
    .set({ status: 'recycled', recycledAt: new Date() })
    .where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.marked_recycled', cardId });
}

export async function markActive(
  db: DB,
  cardId: string,
  userId: string,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db
    .update(cards)
    .set({ status: 'active', userId, lastUsedAt: new Date() })
    .where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.marked_active', cardId, userId });
}

export async function updateBalance(
  db: DB,
  cardId: string,
  deltaCents: number,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db
    .update(cards)
    .set({ balanceUsdCents: sql`${cards.balanceUsdCents} + ${deltaCents}` })
    .where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.balance_updated', cardId, deltaCents });
}

/**
 * Массовый recycle для cron `recycle-cards` (раз в сутки).
 *  - active + last_used_at < now - 90d → idle
 *  - idle   + created_at  < now - 180d → recycled
 */
export async function recycleAgedCards(
  db: DB,
  log: RepoLogger = noopLogger,
): Promise<{ idled: number; recycled: number }> {
  const idledRows = await db.execute<{ id: string }>(sql`
    UPDATE cards
    SET status = 'idle', last_used_at = COALESCE(last_used_at, now())
    WHERE status = 'active' AND last_used_at < now() - interval '90 days'
    RETURNING id
  `);

  const recycledRows = await db.execute<{ id: string }>(sql`
    UPDATE cards
    SET status = 'recycled', recycled_at = now()
    WHERE status = 'idle' AND recycled_at IS NULL AND created_at < now() - interval '180 days'
    RETURNING id
  `);

  const idled = idledRows.length;
  const recycled = recycledRows.length;
  log.info({ event: 'db.cards.recycled_aged', idled, recycled });
  return { idled, recycled };
}

function mapRowToCard(row: typeof cards.$inferSelect): Card {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    providerCardId: row.providerCardId,
    panMasked: row.panMasked,
    status: row.status,
    balanceUsdCents: row.balanceUsdCents,
    lastUsedAt: row.lastUsedAt,
    recycledAt: row.recycledAt,
    createdAt: row.createdAt,
  };
}
