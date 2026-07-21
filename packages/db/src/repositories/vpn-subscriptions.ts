import { eq, sql } from 'drizzle-orm';

import { vpnSubscriptions } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий VPN-подписок (Remnawave). Снимок выданной ссылки-подписки:
 * повторное нажатие кнопки «VPN» возвращает её из БД без похода в панель,
 * «Обновить ссылку» перезаписывает снимок на месте (upsert по user_id).
 */

export type VpnSubscription = {
  id: string;
  userId: string;
  telegramId: string;
  remnawaveUuid: string;
  shortUuid: string;
  subscriptionUrl: string;
  status: string;
  expireAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertVpnSubscriptionInput = {
  userId: string;
  telegramId: string;
  remnawaveUuid: string;
  shortUuid: string;
  subscriptionUrl: string;
  status: string;
  expireAt: Date;
};

type VpnSubscriptionRow = typeof vpnSubscriptions.$inferSelect;

function mapRow(row: VpnSubscriptionRow): VpnSubscription {
  return {
    id: row.id,
    userId: row.userId,
    telegramId: row.telegramId,
    remnawaveUuid: row.remnawaveUuid,
    shortUuid: row.shortUuid,
    subscriptionUrl: row.subscriptionUrl,
    status: row.status,
    expireAt: row.expireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findVpnSubscriptionByUserId(
  db: DB,
  userId: string,
): Promise<VpnSubscription | null> {
  const rows = await db
    .select()
    .from(vpnSubscriptions)
    .where(eq(vpnSubscriptions.userId, userId))
    .limit(1);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * INSERT … ON CONFLICT (user_id) DO UPDATE: первая выдача создаёт строку,
 * «Обновить ссылку» / adopt существующего юзера панели обновляют снимок на
 * месте. `created_at` сохраняется, `updated_at` — SQL `now()`.
 */
export async function upsertVpnSubscription(
  db: DB,
  input: UpsertVpnSubscriptionInput,
  log: RepoLogger = noopLogger,
): Promise<VpnSubscription> {
  const rows = await db
    .insert(vpnSubscriptions)
    .values({
      userId: input.userId,
      telegramId: input.telegramId,
      remnawaveUuid: input.remnawaveUuid,
      shortUuid: input.shortUuid,
      subscriptionUrl: input.subscriptionUrl,
      status: input.status,
      expireAt: input.expireAt,
    })
    .onConflictDoUpdate({
      target: vpnSubscriptions.userId,
      set: {
        telegramId: input.telegramId,
        remnawaveUuid: input.remnawaveUuid,
        shortUuid: input.shortUuid,
        subscriptionUrl: input.subscriptionUrl,
        status: input.status,
        expireAt: input.expireAt,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error('upsertVpnSubscription: INSERT … ON CONFLICT не вернул строку');
  }

  // shortUuid не логируем: это хвост ссылки-подписки, по нему ссылка
  // восстанавливается из логов (политика «токены не логируются»).
  log.info({
    event: 'db.vpn_subscriptions.upserted',
    userId: input.userId,
    remnawaveUuid: input.remnawaveUuid,
  });

  return mapRow(row);
}
