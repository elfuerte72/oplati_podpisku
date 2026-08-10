import { and, eq, sql } from 'drizzle-orm';

import { cards } from '../schema.ts';
import type { DB } from '../index.ts';
import { CARD_LIFETIME_DAYS, type CardStatus } from '@oplati/types';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий виртуальных USD-карт (app.pay.space). Карты создаются `issue-card`
 * job-ом после успешной оплаты, доливаются под новые заказы того же пользователя
 * весь свой срок и через `CARD_LIFETIME_DAYS` от выпуска закрываются в
 * провайдере → `recycled`. Срок — из `@oplati/types`, тот же источник, что у
 * витринного «Действует до» в кабинете.
 *
 * `idle` — НЕ возрастной статус: он ставится только когда PaySpace отклонил
 * долив (карта протухла/заблокирована/из чужого аккаунта) и `issue-card`
 * выводит карту из реюза, чтобы выпустить новую вместо падения оплаченного
 * заказа. Возрастное идление после 90 дней убрано (решение владельца
 * 2026-07-25): оно осталось от отменённого пула переиспользования между
 * клиентами, а на практике лишь лишало клиента долива на 91-й день.
 * Cross-client reuse убран: `release` необратим, PAN между клиентами не делим.
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
 *
 * Отсечка по возрасту — та же, что у выборок кабинета (аудит 2026-08-10, HIGH).
 * Без неё эта функция была ЕДИНСТВЕННОЙ card-выборкой без возрастного условия:
 * карта любого возраста — 200, 300 дней — возвращалась как активная и
 * доливалась деньгами клиента, а `recycle-cards` закрывал её необратимым
 * `release`, возвращая остаток на наш VCC.
 *
 * Граница РОВНО `CARD_LIFETIME_DAYS`, без собственного запаса: те же 180 дней
 * видит кабинет (`findCardsByUserIdForCabinet`, `findCardByIdForUser`,
 * «Действует до») и `propose-order`, решая, брать ли надбавку за выпуск. Своя
 * укороченная граница здесь означала бы сутки, в которые кабинет показывает
 * карту рабочей и отдаёт по ней реквизиты, а заказ втихую берёт $4 за выпуск
 * новой. Запас перед самой денежной операцией живёт в `issue-card`
 * (`isCardTopupSafe`), где ему и место.
 */
export async function findActiveByUserId(db: DB, userId: string): Promise<Card | null> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        eq(cards.status, 'active'),
        sql`${cards.createdAt} >= now() - make_interval(days => ${CARD_LIFETIME_DAYS})`,
      ),
    )
    .orderBy(sql`${cards.createdAt} DESC`)
    .limit(1);

  const row = rows[0];
  return row ? mapRowToCard(row) : null;
}

/**
 * Карты пользователя для личного кабинета (Mini App): только `active` и `idle`,
 * и только пока не истёк `CARD_LIFETIME_DAYS` от выпуска.
 * `recycled` скрываем — такая карта могла быть переназначена другому владельцу,
 * показывать её прежнему клиенту нельзя. Свежие первыми. Read-only.
 *
 * Отсечка по возрасту нужна отдельно от статуса: между 180-м днём и следующим
 * прогоном cron (03:30) — или если `releaseCard` упал и добивается на следующем
 * запуске — карта ещё `active`/`idle`, и без этого условия кабинет показывал бы
 * её как рабочую с датой «Действует до» в прошлом. Условие держит витрину
 * согласованной с обещанием срока независимо от расписания и сбоев провайдера.
 */
export async function findCardsByUserIdForCabinet(db: DB, userId: string): Promise<Card[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        sql`${cards.status} IN ('active', 'idle')`,
        sql`${cards.createdAt} >= now() - make_interval(days => ${CARD_LIFETIME_DAYS})`,
      ),
    )
    .orderBy(sql`${cards.createdAt} DESC`);
  return rows.map(mapRowToCard);
}

/**
 * Карта по id с проверкой владельца (ownership) — для разового показа реквизитов
 * в кабинете. `recycled` исключаем (карта могла уйти другому клиенту — реквизиты
 * прежнему показывать нельзя), карты старше `CARD_LIFETIME_DAYS` — тоже: срок
 * истёк, и отдавать по ней полный PAN/CVC нельзя даже в окне до прогона cron.
 * Условие держим тем же, что в `findCardsByUserIdForCabinet`, иначе карта
 * пропала бы из списка, но реквизиты по прямому `card-details` всё ещё отдавались.
 * `null`, если карты нет, чужая, recycled или просрочена.
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
        sql`${cards.createdAt} >= now() - make_interval(days => ${CARD_LIFETIME_DAYS})`,
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? mapRowToCard(row) : null;
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
 * Синхронизация баланса с провайдером: кабинет перед показом тянет live-баланс
 * из PaySpace (`getCardInfo`) и кэширует его сюда — сам по себе БД-снимок знает
 * только НАШИ движения (topup/withdraw), списания клиента на сайте сервиса в
 * него не попадают.
 *
 * Compare-and-set: пишем только если баланс в БД всё ещё равен тому, что
 * читатель видел (`expectedBalanceUsdCents`) — иначе параллельный
 * `updateBalance` (topup из issue-card в момент просмотра кабинета) был бы
 * молча затёрт устаревшим live-значением. `false` = проиграли гонку, кэш не
 * тронут. В отличие от `updateBalance` НЕ трогает `last_used_at`: это пассивное
 * чтение, а от `last_used_at` recycle-cron меряет простой — просмотр кабинета
 * не должен бесконечно держать карту от идла.
 */
export async function syncCardBalance(
  db: DB,
  cardId: string,
  balanceUsdCents: number,
  expectedBalanceUsdCents: number,
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const updated = await db
    .update(cards)
    .set({ balanceUsdCents })
    .where(and(eq(cards.id, cardId), eq(cards.balanceUsdCents, expectedBalanceUsdCents)))
    .returning({ id: cards.id });
  const applied = updated.length > 0;

  log.info({ event: 'db.cards.balance_synced', cardId, balanceUsdCents, applied });
  return applied;
}

/**
 * Шаг 2 cron `recycle-cards`: карты, отслужившие `CARD_LIFETIME_DAYS` от
 * ВЫПУСКА и ещё не закрытые (`recycled_at IS NULL`). Возвращаем строки — джоба
 * закроет каждую в провайдере (`releaseCard`, необратимо) и только затем
 * пометит `markRecycled`. Поэтому это SELECT, а не bulk-UPDATE: at-least-once с
 * пер-картной обработкой ошибок провайдера (упавшую карту добьёт следующий запуск).
 *
 * Берём и `active`, и `idle`. Раньше условие было `status = 'idle'`, и карта,
 * которую клиент регулярно доливал (каждый топап обновляет `last_used_at`),
 * никогда не доживала до `idle` — а значит НЕ закрывалась ВООБЩЕ, ни на 180-й
 * день, ни на 300-й. При этом кабинет всё это время показывал ей «Действует до»
 * = `created_at + CARD_LIFETIME_DAYS`, то есть дату в прошлом. Срок жизни карты
 * жёсткий и считается от выпуска, статус на него не влияет.
 */
const RECYCLE_BATCH_LIMIT = 100;

export async function findCardsToRecycle(db: DB): Promise<Card[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      and(
        sql`${cards.status} IN ('active', 'idle')`,
        sql`${cards.recycledAt} IS NULL`,
        sql`${cards.createdAt} < now() - make_interval(days => ${CARD_LIFETIME_DAYS})`,
      ),
    )
    .orderBy(sql`${cards.createdAt} ASC`)
    // Кап: каждая карта в пачке — это сетевой вызов release к PaySpace, и
    // накопленный хвост без предела упёрся бы в таймаут крона, не закрыв ни
    // одной. Сортировка по возрасту гарантирует, что первыми уходят самые
    // старые, а остаток заберёт следующий суточный прогон.
    .limit(RECYCLE_BATCH_LIMIT);
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
