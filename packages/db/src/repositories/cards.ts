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
 * Карта по id с проверкой владельца (ownership) — для разового показа реквизитов
 * в кабинете. `recycled` исключаем (карта могла уйти другому клиенту — реквизиты
 * прежнему показывать нельзя). `null`, если карты нет, чужая или recycled.
 * Read-only; полные реквизиты тянем отдельно из PaySpace по `providerCardId`.
 */
export async function findCardByIdForUser(
  db: DB,
  cardId: string,
  userId: string,
): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.id, cardId),
        eq(cards.userId, userId),
        sql`${cards.status} IN ('active', 'idle')`,
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? mapRowToCard(row) : null;
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
    // Топ-ап = использование карты клиентом → продлеваем last_used_at, чтобы
    // recycle-cards не заидлил активно используемую карту раньше времени (M5).
    .set({ balanceUsdCents: sql`${cards.balanceUsdCents} + ${deltaCents}`, lastUsedAt: new Date() })
    .where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.balance_updated', cardId, deltaCents });
}

/**
 * Абсолютная синхронизация баланса с провайдером: кабинет перед показом тянет
 * live-баланс из PaySpace (`getCardInfo`) и кэширует его сюда — сам по себе
 * БД-снимок знает только НАШИ движения (topup/withdraw), списания клиента на
 * сайте сервиса в него не попадают. В отличие от `updateBalance` НЕ трогает
 * `last_used_at`: это пассивное чтение, а от `last_used_at` recycle-cron меряет
 * простой — просмотр кабинета не должен бесконечно держать карту от идла.
 */
export async function syncCardBalance(
  db: DB,
  cardId: string,
  balanceUsdCents: number,
  log: RepoLogger = noopLogger,
): Promise<void> {
  await db.update(cards).set({ balanceUsdCents }).where(eq(cards.id, cardId));

  log.info({ event: 'db.cards.balance_synced', cardId, balanceUsdCents });
}

/**
 * Шаг 1 cron `recycle-cards`: active + простой > 90d → idle.
 * Чистое БД-изменение, без обращения к провайдеру. Возвращает число затронутых.
 *
 * Простой меряем от `COALESCE(last_used_at, created_at)`: у нормально живущих
 * карт `last_used_at` = NULL (createCard его не ставит, а `NULL < timestamp` в
 * Postgres даёт NULL, не TRUE), поэтому фильтр по одному `last_used_at` никогда
 * не матчил активные карты — они не идлились и не доходили до release, а буфер
 * VCC оставался заперт (M5). Fallback на `created_at` чинит это для карт, ещё
 * ни разу не использованных.
 */
export async function idleAgedActiveCards(
  db: DB,
  log: RepoLogger = noopLogger,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE cards
    SET status = 'idle', last_used_at = COALESCE(last_used_at, now())
    WHERE status = 'active' AND COALESCE(last_used_at, created_at) < now() - interval '90 days'
    RETURNING id
  `);
  const idled = rows.length;
  log.info({ event: 'db.cards.idled_aged', idled });
  return idled;
}

/**
 * Шаг 2 cron `recycle-cards`: idle-карты, отслужившие 180 дней и ещё НЕ
 * закрытые (`recycled_at IS NULL`). Возвращаем строки — джоба закроет каждую в
 * провайдере (`releaseCard`, необратимо) и только затем пометит `markRecycled`.
 * Поэтому это SELECT, а не bulk-UPDATE: at-least-once с пер-картной обработкой
 * ошибок провайдера (упавшую карту добьёт следующий запуск).
 */
export async function findCardsToRecycle(db: DB): Promise<Card[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.status, 'idle'),
        sql`${cards.recycledAt} IS NULL`,
        sql`${cards.createdAt} < now() - interval '180 days'`,
      ),
    )
    .orderBy(sql`${cards.createdAt} ASC`);
  return rows.map(mapRowToCard);
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
