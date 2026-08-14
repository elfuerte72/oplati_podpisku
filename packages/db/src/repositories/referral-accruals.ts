import { sql } from 'drizzle-orm';

import type { DB, DBLike } from '../index.ts';
import { PURCHASED_STATUSES_SQL, REFUND_OR_FAILED_STATUSES_SQL } from './order-status-sql.ts';

/**
 * Ledger начислений (Этап B). Append-only: только INSERT, никогда UPDATE/DELETE.
 * Идемпотентность commission — UNIQUE(payment_id, beneficiary, level) +
 * ON CONFLICT DO NOTHING. Расчёт ставок — чистый planCommissionAccruals
 * (@oplati/types); здесь только примитивы доступа к БД.
 */

export type PartnerProfile = {
  circle: number;
  lockedRateL1Bps: number;
  /** Активный буст в bps (0 если истёк/не задан — считается на стороне SQL). */
  boostBps: number;
  suspended: boolean;
};

/**
 * Профиль партнёра для расчёта ставки. `null` — профиля ещё нет (трактуется как
 * круг 0 / Клиент). Буст применяется только если `boost_until >= CURRENT_DATE`.
 */
export async function getPartnerProfile(db: DB, userId: string): Promise<PartnerProfile | null> {
  const rows = await db.execute<{
    current_circle: number;
    locked_rate_l1_bps: number;
    boost_bps: number;
    suspended: boolean;
  }>(sql`
    SELECT
      current_circle,
      locked_rate_l1_bps,
      CASE
        WHEN boost_until IS NOT NULL AND boost_until >= CURRENT_DATE
        THEN COALESCE(boost_rate_bps, 0)
        ELSE 0
      END AS boost_bps,
      suspended
    FROM referral_partners
    WHERE user_id = ${userId}
    LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    circle: r.current_circle,
    lockedRateL1Bps: r.locked_rate_l1_bps,
    boostBps: r.boost_bps,
    suspended: r.suspended,
  };
}

export type CommissionAccrualInsert = {
  beneficiaryUserId: string;
  level: number;
  rateBps: number;
  amountUsdCents: number;
};

/**
 * Вставляет commission-начисления идемпотентно (ON CONFLICT DO NOTHING по
 * частичному UNIQUE(payment_id, beneficiary, level) WHERE status='accrued').
 * Индекс частичный (находка аудита I2): полный блокировал бы reversal-контракт
 * ledger'а — «reversal = НОВАЯ строка status='reversed'» с теми же ключами.
 * Возвращает число РЕАЛЬНО вставленных строк (0 при полном дубле — повторный
 * webhook/poll). В одноуровневой программе строка одна (прямой реферер),
 * поэтому простой цикл, а не bulk-INSERT.
 */
export async function insertCommissionAccruals(
  db: DB,
  params: {
    sourceUserId: string;
    orderId: string;
    paymentId: string;
    rows: readonly CommissionAccrualInsert[];
  },
): Promise<number> {
  const { sourceUserId, orderId, paymentId, rows } = params;
  if (rows.length === 0) return 0;
  // Транзакция: строки вставляются атомарно (all-or-nothing) — recovery-гейт
  // (NOT EXISTS любой строки) видит заказ либо целиком начисленным, либо нет.
  return db.transaction(async (tx) => {
    let inserted = 0;
    for (const row of rows) {
      const res = await tx.execute<{ id: string }>(sql`
        INSERT INTO referral_accruals
          (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind, rate_bps, amount_usd_cents)
        VALUES (
          ${row.beneficiaryUserId}, ${sourceUserId}, ${orderId}, ${paymentId},
          ${row.level}, 'commission', ${row.rateBps}, ${row.amountUsdCents}
        )
        ON CONFLICT (payment_id, beneficiary_user_id, level) WHERE status = 'accrued' DO NOTHING
        RETURNING id
      `);
      if (res[0]?.id) inserted++;
    }
    return inserted;
  });
}

/**
 * Формула доступного баланса партнёра одним SQL-фрагментом:
 *   начислено − отменено − выводы (`requested|processing|paid`).
 *
 * Единственное определение на весь код: до этого та же арифметика жила в
 * `getReferralBalanceUsdCents` и дважды внутри выборки отрицательных балансов —
 * ровно тот вид дублирования денежного понятия, который эта ветка убирает в
 * других местах (находка ревью). `userId` подставляется вызывающим.
 */
function balanceExpr(userId: unknown) {
  return sql`(
    COALESCE((SELECT SUM(amount_usd_cents) FROM referral_accruals
              WHERE beneficiary_user_id = ${userId} AND status = 'accrued'), 0)
    - COALESCE((SELECT SUM(amount_usd_cents) FROM referral_accruals
                WHERE beneficiary_user_id = ${userId} AND status = 'reversed'), 0)
    - COALESCE((SELECT SUM(amount_usd_cents) FROM referral_payouts
                WHERE user_id = ${userId} AND status IN ('requested', 'processing', 'paid')), 0)
  )`;
}

/**
 * Доступный к выводу баланс партнёра (USD-центы):
 *   начислено (accrued) − реверснуто (reversed) − выводы (requested|processing|paid).
 *
 * - `reversed` вычитается (находка ревью): reversal по контракту — НОВАЯ строка
 *   status='reversed' той же суммы (append-only, исходная остаётся 'accrued'),
 *   поэтому в балансе её надо гасить вычитанием, иначе reversal не уменьшал бы баланс.
 * - `requested`-выводы вычитаются (находка security): иначе две параллельные заявки
 *   увидели бы полный баланс и обе прошли → перевывод. `rejected`-заявки не считаются.
 * - Cast `::bigint` + Number — без переполнения на $21M+, в духе «деньги — integer».
 */
export async function getReferralBalanceUsdCents(db: DB, userId: string): Promise<number> {
  const rows = await db.execute<{ balance: string | number }>(sql`
    SELECT ${balanceExpr(userId)}::bigint AS balance
  `);
  return Number(rows[0]?.balance ?? 0);
}


/**
 * Отмена реферальных начислений заказа, который после оплаты ушёл в `failed`
 * (R-1). Комиссия платится из маржи исполненного заказа; провалившийся заказ
 * маржи не приносит, а деньги клиенту возвращаются.
 *
 * Остальная система уже считает `failed` НЕ покупкой: этот статус не входит в
 * `PURCHASED_ORDER_STATUSES` ни у прогрессии (оборот сети), ни у витрины, ни у
 * выборки recovery. Ledger был единственным местом, где провалившийся заказ продолжал
 * приносить партнёру деньги, и попадание в это состояние зависело от гонки:
 * успел inline-путь начислить до провала — начисление оставалось навсегда, не
 * успел — recovery его уже не досчитывал.
 *
 * Append-only (инвариант 1): исходная строка `accrued` НЕ трогается, отмена —
 * новая строка `reversed` с теми же ключами; агрегаты кабинета её вычитают.
 * Частичный UNIQUE на ledger'е покрывает только `status='accrued'`, поэтому
 * такая вставка проходит.
 *
 * `created_at` — момент отмены, а НЕ копия исходного (в отличие от гашения
 * самореферала в `consumeLinkToken`, где копия нужна, чтобы месячные агрегаты
 * не уходили в минус): отмена должна попасть в тот месяц, когда произошла,
 * иначе задним числом изменится уже показанная партнёру цифра за прошлый месяц.
 *
 * Гасит ТОЛЬКО заказы, реально лежащие в `failed`/`refunded`
 * (`REFUND_OR_FAILED_ORDER_STATUSES`) — проверка по данным, а не по месту
 * вызова (находка ревью). Точки вызова глотают запрещённый переход:
 * `markOrderFailed` ловит `OrderTransitionError` и всё равно доходит до отмены,
 * так что заказ, уже ушедший в `completed`, лишался бы комиссии партнёра — и
 * вернуть её нечем (recovery считает пропуском только заказ без строк ledger'а,
 * а повторная вставка упрётся в частичный UNIQUE). Заодно это делает безопасной
 * любую будущую точку вызова.
 *
 * Идемпотентность держится ДВУМЯ слоями. `NOT EXISTS` отсекает обычный повтор
 * (ретрай крона, второй webhook), но сам по себе гарантии не даёт: в READ
 * COMMITTED два параллельных вызова — inline-путь провала заказа и бэкстоп-крон
 * — не видят чужую незакоммиченную строку и вставляют обе, уводя баланс в
 * минус. Настоящую гарантию даёт частичный UNIQUE
 * `referral_accruals_order_reversal_idx` (миграция 0030) + `ON CONFLICT DO
 * NOTHING`; проигравший гонку просто вернёт на одну строку меньше.
 *
 * ⚠️ Обратный путь НЕ автоматизирован. State machine разрешает воскрешение
 * `failed → refund_requested → completed` (ручной разбор), и у такого заказа
 * начисление останется погашенным: `findOrdersMissingReferralAccruals` считает
 * пропуском только заказ БЕЗ строк ledger'а, а здесь строки есть. Досчитать
 * автоматически нельзя и по второму кругу: исходная `accrued` жива, и повторный
 * `insertCommissionAccruals` упрётся в частичный UNIQUE. Восстановление —
 * ручное, оператором. Автовосстановление сознательно не делаем: риск двойного
 * начисления на редком пути дороже, чем разовая ручная правка.
 *
 * @returns сколько строк погашено (0 — гасить было нечего)
 */
export async function reverseAccrualsForOrder(db: DBLike, orderId: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO referral_accruals
      (beneficiary_user_id, source_user_id, order_id, payment_id, level, kind,
       rate_bps, amount_usd_cents, status)
    SELECT a.beneficiary_user_id, a.source_user_id, a.order_id, a.payment_id, a.level,
           a.kind, a.rate_bps, a.amount_usd_cents, 'reversed'
    FROM referral_accruals a
    JOIN orders o ON o.id = a.order_id AND o.status IN ${REFUND_OR_FAILED_STATUSES_SQL}
    WHERE a.order_id = ${orderId}
      AND a.status = 'accrued'
      AND NOT EXISTS (
        SELECT 1 FROM referral_accruals r
        WHERE r.status = 'reversed'
          AND r.order_id = a.order_id
          AND r.payment_id IS NOT DISTINCT FROM a.payment_id
          AND r.beneficiary_user_id = a.beneficiary_user_id
          AND r.level = a.level
          AND r.kind = a.kind
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return rows.length;
}

/**
 * Заказы, по которым деньги клиенту не остаются у нас (`failed`/`refunded`), с
 * ЖИВЫМИ (непогашенными) начислениями — расхождение ledger'а для бэкстопа cron
 * `referral-recovery` (R-1.7).
 *
 * Inline-вызовов отмены сегодня два (провал фулфилмента и недоплата), завтра их
 * может стать больше, и забытая точка означает молча завышенный баланс партнёра
 * — то есть ровно исходный баг, только в новом месте. Тот же двухслойный
 * приём, что и у начисления: inline + сверка кроном.
 *
 * Без временного окна (в отличие от `findOrdersMissingReferralAccruals`):
 * расхождений в норме НЕТ вообще, выборка идёт по узкому набору `failed`-заказов
 * с начислениями, и старое расхождение молча похоронить нельзя — это деньги.
 */
export async function findOrdersWithUnreversedAccruals(
  db: DBLike,
  limit: number,
): Promise<UnreversedAccrualOrder[]> {
  const rows = await db.execute<{ order_id: string; status: string }>(sql`
    SELECT DISTINCT a.order_id, o.status
    FROM referral_accruals a
    JOIN orders o ON o.id = a.order_id AND o.status IN ${REFUND_OR_FAILED_STATUSES_SQL}
    WHERE a.status = 'accrued'
      AND NOT EXISTS (
        SELECT 1 FROM referral_accruals r
        WHERE r.status = 'reversed'
          AND r.order_id = a.order_id
          AND r.payment_id IS NOT DISTINCT FROM a.payment_id
          AND r.beneficiary_user_id = a.beneficiary_user_id
          AND r.level = a.level
          AND r.kind = a.kind
      )
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ orderId: r.order_id, status: r.status }));
}

/** Заказ с непогашенным начислением + его статус (нужен для тона алёрта). */
export type UnreversedAccrualOrder = { orderId: string; status: string };

/**
 * Партнёры с отрицательным балансом — аномалия, требующая человека.
 *
 * Возникает, когда отмена приходит на деньги, по которым уже подана заявка на
 * вывод: заявка вычитается из баланса, и клавбэк вычитается вторым разом.
 * Формула — общий `balanceExpr`, тот же, что у `getReferralBalanceUsdCents`.
 * Выплаты сейчас ручные, поэтому ценность сигнала в том, чтобы владелец узнал
 * ДО перевода денег (находка ревью).
 */
export async function findNegativeReferralBalances(
  db: DBLike,
  limit: number,
): Promise<{ userId: string; balanceUsdCents: number }[]> {
  const rows = await db.execute<{ user_id: string; balance: string | number }>(sql`
    SELECT p.user_id, ${balanceExpr(sql`p.user_id`)}::bigint AS balance
    FROM (SELECT DISTINCT beneficiary_user_id AS user_id FROM referral_accruals) p
    WHERE ${balanceExpr(sql`p.user_id`)} < 0
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ userId: r.user_id, balanceUsdCents: Number(r.balance) }));
}

/**
 * Есть ли у заказа хоть одна строка начисления (любого kind) — для recovery-крона
 * (Этап B ч.2): заказ paid+ с реферером, но без начислений = пропуск, досчитать.
 */
export async function orderHasAccruals(db: DB, orderId: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM referral_accruals WHERE order_id = ${orderId}
    ) AS exists
  `);
  return rows[0]?.exists ?? false;
}

export type OrderMissingAccrual = { orderId: string; paymentId: string };

/**
 * Recovery-кандидаты: заказы paid+ у пользователя с реферером, с USD-базой и
 * успешным платежом, но БЕЗ единой строки начисления (пропуск, если БД упала в
 * момент webhook).
 *
 * Гейты против ложной атрибуции и churn'а (находки security/code-review):
 *  - `o.paid_at >= u.referred_by_set_at` — НЕ начисляем на заказы, оплаченные ДО
 *    появления реферера (D-REF-9: merge может проставить реферера задним числом;
 *    без гейта recovery back-pay'нул бы комиссию на исторические заказы). NULL
 *    referred_by_set_at → условие ложно → заказ исключён (консервативно).
 *  - окно 30 дней — ограничивает повторный перебор «легитимно пустых» цепочек
 *    (все предки suspended) каждый час; реальные пропуски ловятся inline+recovery
 *    задолго до этого.
 *  - `DISTINCT ON (o.id)` — ровно один платёж на заказ (иначе двойное начисление
 *    на разные payment_id). NOT EXISTS гасит уже начисленные.
 * accrueReferralForPayment перепроверит всё сам и идемпотентен.
 */
export async function findOrdersMissingReferralAccruals(
  db: DB,
  limit: number,
): Promise<OrderMissingAccrual[]> {
  const rows = await db.execute<{ order_id: string; payment_id: string }>(sql`
    SELECT order_id, payment_id FROM (
      SELECT DISTINCT ON (o.id)
        o.id AS order_id,
        p.id AS payment_id,
        o.paid_at AS paid_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
        AND u.referred_by IS NOT NULL
        AND u.referred_by_set_at IS NOT NULL
        AND o.paid_at >= u.referred_by_set_at
      JOIN payments p ON p.order_id = o.id AND p.status = 'succeeded'
      WHERE o.status IN ${PURCHASED_STATUSES_SQL}
        AND o.original_amount IS NOT NULL
        AND o.original_amount > 0
        AND o.paid_at >= now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM referral_accruals ra WHERE ra.order_id = o.id
        )
      ORDER BY o.id, p.created_at DESC
    ) s
    ORDER BY s.paid_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ orderId: r.order_id, paymentId: r.payment_id }));
}
