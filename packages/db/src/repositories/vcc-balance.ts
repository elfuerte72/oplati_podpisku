import { and, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';

import { orders, vccBalanceSnapshots, vccFundReservations } from '../schema.ts';
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

// ─── Резервы фонда (тикет 05) ─────────────────────────────────────────────

/**
 * Замок расчёта карточного фонда.
 *
 * ⚠️ Держится ТОЛЬКО на время подсчёта и снимается на COMMIT/ROLLBACK — до
 * обращения к платёжному шлюзу. Обратное («залочили и пошли в Freekassa»)
 * выстроило бы все оплаты страны в одну очередь за чужим API с таймаутом 45
 * секунд.
 *
 * Ключ один на весь фонд: он и есть общий ресурс, за который идёт гонка.
 * Конкуренты за другие ресурсы (диалоги, реферальные балансы) берут свои ключи
 * и друг друга не задевают.
 *
 * ⚠️ Порядок взятия: этот замок берётся ПЕРВЫМ, до любых строчных блокировок.
 * Вызвать гейт фонда изнутри транзакции, уже держащей `FOR UPDATE` на заказе,
 * значит замкнуть цикл и получить настоящий дедлок — сейчас такого вызова нет
 * и заводить его нельзя.
 */
/**
 * Сколько ждать своей очереди у замка фонда.
 *
 * Полторы секунды — это «очередь длиннее десятков расчётов»: каждый держит
 * замок миллисекунды. Не дождались — значит либо всплеск оплат, либо чужая
 * долгая транзакция по заказу; и то, и другое лучше закончить отказом, чем
 * ожиданием, которое клиент видит как зависшую кнопку.
 *
 * ⚠️ Поводок действует на КАЖДОЕ ожидание в транзакции (сам замок, потом
 * FK-блокировка строки заказа), поэтому в худшем случае он стоит вдвое. Это
 * прямо вычитается из запаса до обрыва self-call `confirm_order`: у Freekassa
 * счёт создаётся до 40 секунд, а обрыв — на 50-й. Растить это число нельзя,
 * не подняв там таймаут.
 */
const FUND_LOCK_TIMEOUT = '1500ms';

export async function acquireCardFundLock(tx: DBLike): Promise<void> {
  // ⚠️ Поводок на ЛЮБОЕ ожидание блокировки в этой транзакции, включая сам
  // advisory-lock и FK-блокировку строки заказа при вставке резерва.
  //
  // Без него схема кусает себя за хвост: вставка резерва берёт на заказе
  // `FOR KEY SHARE`, а `transitionOrder` держит на нём `FOR UPDATE` (крон
  // `expire-payments` хоронит протухший черновик ровно в этот момент) — и наш
  // claim ЖДЁТ, не отпуская глобальный замок фонда. За ним встают все оплаты
  // сразу, то есть ровно то, чего трек избегает, только с другой стороны.
  //
  // `SET LOCAL` живёт до конца транзакции и откатывается сам.
  await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${FUND_LOCK_TIMEOUT}'`)}`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vcc-funding')::bigint)`);
}

/**
 * Сколько фонда занято живыми резервами.
 *
 * ⚠️ Считаются только резервы заказов, ЕЩЁ находящихся в `ready_for_payment`.
 * Как только заказ ушёл к оплате, его деньги учитываются по статусу
 * (`findOrdersCommittingCardFund`), и складывать оба значило бы вычесть один
 * заказ дважды — то есть отказывать клиентам за чужой счёт.
 *
 * Протухшие резервы не считаются вовсе: умерший между занятием и счётом
 * процесс не должен запирать фонд дольше срока счёта.
 */
export async function sumLiveCardFundReservations(
  tx: DBLike,
  now: Date,
  opts: {
    /**
     * Не считать резерв этого заказа.
     *
     * ⚠️ Нужен на повторном нажатии: заказ, занявший деньги секунду назад,
     * иначе вычитал бы СВОИ же средства и получал отказ от самого себя.
     */
    excludeOrderId?: string;
  } = {},
): Promise<number> {
  const rows = await tx
    .select({ amountUsdCents: vccFundReservations.amountUsdCents })
    .from(vccFundReservations)
    .innerJoin(orders, eq(orders.id, vccFundReservations.orderId))
    .where(
      and(
        gt(vccFundReservations.expiresAt, now),
        eq(orders.status, 'ready_for_payment'),
        ...(opts.excludeOrderId ? [ne(vccFundReservations.orderId, opts.excludeOrderId)] : []),
      ),
    );
  return rows.reduce((sum, r) => sum + r.amountUsdCents, 0);
}

/**
 * Занять фонд под заказ. Идемпотентно по заказу: повторное нажатие обновляет
 * сумму и срок той же строки, а не занимает деньги второй раз.
 */
export async function insertCardFundReservation(
  tx: DBLike,
  input: { orderId: string; amountUsdCents: number; expiresAt: Date },
): Promise<void> {
  await tx
    .insert(vccFundReservations)
    .values({
      orderId: input.orderId,
      amountUsdCents: input.amountUsdCents,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: vccFundReservations.orderId,
      set: { amountUsdCents: input.amountUsdCents, expiresAt: input.expiresAt },
    });
}

/**
 * Освободить занятые деньги немедленно — счёт создать не удалось.
 *
 * Без этого шага фонд простоял бы запертым до срока счёта (час) из-за ошибки,
 * о которой мы узнали сразу.
 */
export async function releaseCardFundReservation(tx: DBLike, orderId: string): Promise<void> {
  await tx.delete(vccFundReservations).where(eq(vccFundReservations.orderId, orderId));
}

/**
 * Убрать протухшие занятия фонда.
 *
 * Строка не удаляется в момент успеха — заказ ушёл к оплате, и резерв просто
 * перестал влиять (учёт идёт по статусу). Копятся они поэтому навсегда, а
 * выборка живых занятий выполняется ВНУТРИ глобального замка: чем длиннее
 * таблица, тем дольше стоят все оплаты сразу. Индекс по сроку это держит, но
 * мусор всё равно незачем хранить.
 *
 * Порог с запасом относительно срока счёта: удалять «сразу как протухло» —
 * значит терять след для разбора инцидента в тот же день.
 */
export async function deleteExpiredCardFundReservations(
  db: DBLike,
  input: { olderThanDays: number; limit: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(vccFundReservations)
    .where(
      inArray(
        vccFundReservations.orderId,
        db
          .select({ orderId: vccFundReservations.orderId })
          .from(vccFundReservations)
          .where(lt(vccFundReservations.expiresAt, cutoff))
          .limit(input.limit),
      ),
    )
    .returning({ orderId: vccFundReservations.orderId });
  return rows.length;
}
