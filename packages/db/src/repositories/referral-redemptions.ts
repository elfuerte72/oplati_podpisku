import { sql } from 'drizzle-orm';

import type { DB, DBLike } from '../index.ts';
import { emitDbChange } from '../change-feed.ts';
import { noopLogger, type RepoLogger } from './logger.ts';
import { balanceExpr } from './referral-accruals.ts';

/**
 * Списание реферальных баллов в счёт заказа (трек referral-balance-spend).
 *
 * Примитивы доступа к БД, без единой строки money-math: репозиторий принимает
 * УЖЕ посчитанные центы и копейки (`apps/web/lib/referral/spend-math.ts`), а
 * решает здесь только вопросы состояния и гонок.
 *
 * Таблица — состояние, а не журнал: одна строка на заказ (`order_id` PK),
 * статус движется `reserved → spent | released`. Аудит-след живёт отдельно
 * строками `order_events` (append-only), поэтому история не теряется при смене
 * статуса строки.
 */

export type RedemptionStatus = 'reserved' | 'spent' | 'released';

export type RedemptionRow = {
  orderId: string;
  userId: string;
  amountUsdCents: number;
  discountKopecks: number;
  rateKopecks: number;
  status: RedemptionStatus;
  releasedBy: string | null;
  reservedAt: Date;
  settledAt: Date | null;
};

type RawRedemption = {
  order_id: string;
  user_id: string;
  amount_usd_cents: number;
  discount_kopecks: number;
  rate_kopecks: number;
  status: RedemptionStatus;
  released_by: string | null;
  reserved_at: string | Date;
  settled_at: string | Date | null;
};

function mapRedemption(r: RawRedemption): RedemptionRow {
  return {
    orderId: r.order_id,
    userId: r.user_id,
    amountUsdCents: Number(r.amount_usd_cents),
    discountKopecks: Number(r.discount_kopecks),
    rateKopecks: Number(r.rate_kopecks),
    status: r.status,
    releasedBy: r.released_by,
    reservedAt: new Date(r.reserved_at),
    settledAt: r.settled_at ? new Date(r.settled_at) : null,
  };
}

const SELECT_COLUMNS = sql`
  order_id, user_id, amount_usd_cents, discount_kopecks, rate_kopecks,
  status, released_by, reserved_at, settled_at
`;

export type ReserveBonusResult =
  | { ok: true; balanceUsdCents: number }
  | { ok: false; reason: 'insufficient_balance'; balanceUsdCents: number }
  /**
   * Под этот заказ уже занято — и это НЕ отказ по смыслу: строка принадлежит
   * тому же заказу, просто заняла её другая попытка (двойной тап, вторая
   * вкладка). Вызывающий обязан взять скидку ИЗ НЕЁ, а не из своего свежего
   * расчёта: счёт должен уйти на ту сумму, которая реально занята.
   */
  | {
      ok: false;
      reason: 'already_reserved';
      balanceUsdCents: number;
      existing: RedemptionRow;
    };

/**
 * Занять баллы под заказ.
 *
 * ⚠️ Лок — `pg_advisory_xact_lock(hashtext(userId))`, ТОТ ЖЕ КЛЮЧ, что в
 * `createReferralPayout`: списание и заявка на вывод обязаны сериализоваться
 * между собой, иначе оба видят один и тот же баланс и партнёр занимает центы
 * под заказ и подаёт их же на вывод. По той же причине заявка на вывод считает
 * баланс общим `balanceExpr` — копия формулы там была бы дырой ровно в этом
 * месте.
 *
 * Математика скидки считается ВНЕ транзакции (по прочитанному ранее балансу), а
 * внутри лока проверяется только `balance >= spendUsdCents`. Разошлось —
 * `insufficient_balance` с АКТУАЛЬНЫМ балансом, а не тихое занятие меньшей
 * суммы: клиент нажал «оплатить со скидкой», и молча выставленный полный счёт
 * был бы обманом.
 *
 * Идемпотентность — `order_id` первичным ключом. Повтор по живому резерву
 * возвращает `already_reserved` (звонящий уже занял), а строку, снятую
 * СИСТЕМНЫМ откатом (`released`), занятие воскрешает: `payments/create` снимает
 * занятие в `catch`, и без воскрешения повторная попытка оплатить тот же заказ
 * навсегда теряла бы право на скидку. Возврат ОПЕРАТОРОМ так воскресить нельзя:
 * его кнопка живёт только на заказе в `failed`, а туда путь оплаты не ведёт
 * (`failed → ready_for_payment` машина статусов не разрешает).
 */
export async function reserveBonusForOrder(
  db: DB,
  params: {
    orderId: string;
    userId: string;
    spendUsdCents: number;
    discountKopecks: number;
    rateKopecks: number;
  },
  log: RepoLogger = noopLogger,
): Promise<ReserveBonusResult> {
  const { orderId, userId, spendUsdCents, discountKopecks, rateKopecks } = params;
  if (spendUsdCents <= 0 || discountKopecks <= 0) {
    throw new Error('reserveBonusForOrder: списание должно быть положительным');
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);

    const existingRows = await tx.execute<RawRedemption>(sql`
      SELECT ${SELECT_COLUMNS} FROM referral_redemptions WHERE order_id = ${orderId}
    `);
    const existing = existingRows[0] ? mapRedemption(existingRows[0]) : null;

    const balRows = await tx.execute<{ balance: string | number }>(sql`
      SELECT ${balanceExpr(userId)}::bigint AS balance
    `);
    const balanceUsdCents = Number(balRows[0]?.balance ?? 0);

    if (existing && existing.status !== 'released') {
      return {
        ok: false as const,
        reason: 'already_reserved' as const,
        balanceUsdCents,
        existing,
      };
    }
    if (spendUsdCents > balanceUsdCents) {
      return { ok: false as const, reason: 'insufficient_balance' as const, balanceUsdCents };
    }

    if (existing) {
      // Воскрешение снятого системой занятия: та же строка, свежие числа,
      // автор возврата и отметка закрытия сбрасываются.
      await tx.execute(sql`
        UPDATE referral_redemptions
        SET amount_usd_cents = ${spendUsdCents},
            discount_kopecks = ${discountKopecks},
            rate_kopecks = ${rateKopecks},
            status = 'reserved',
            released_by = NULL,
            reserved_at = now(),
            settled_at = NULL
        WHERE order_id = ${orderId} AND status = 'released'
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO referral_redemptions
          (order_id, user_id, amount_usd_cents, discount_kopecks, rate_kopecks, status)
        VALUES (${orderId}, ${userId}, ${spendUsdCents}, ${discountKopecks}, ${rateKopecks}, 'reserved')
        ON CONFLICT (order_id) DO NOTHING
      `);
    }

    return { ok: true as const, balanceUsdCents: balanceUsdCents - spendUsdCents };
  });

  if (result.ok) {
    log.info({ event: 'db.referral.bonus_reserved', orderId, userId, spendUsdCents, discountKopecks });
    emitDbChange('referral_redemptions');
  }
  return result;
}

/**
 * Вернуть занятые баллы РЕШЕНИЕМ ЧЕЛОВЕКА: `reserved|spent → released`.
 *
 * Условный UPDATE, поэтому повтор идемпотентен (`applied:false` — «уже
 * вернули», а не ошибка).
 *
 * ⚠️ Живой счёт этой функции не помеха — и это намеренно: оператор возвращает
 * баллы по заказу, где деньги как раз приняты. Системный откат несостоявшегося
 * счёта — ДРУГАЯ функция (`releaseUnusedBonusReservation`) со своим условием:
 * снять занятие под уже созданным счётом значило бы отдать клиенту скидку
 * бесплатно.
 *
 * Возвращает саму строку, когда возврат состоялся: вызывающему нужны сумма и
 * пользователь для события `order_events` и сообщения клиенту, а второй запрос
 * за ними после UPDATE читал бы уже изменённое состояние.
 */
export async function releaseBonusReservation(
  db: DBLike,
  params: { orderId: string; releasedBy?: string | null },
  log: RepoLogger = noopLogger,
): Promise<{ applied: boolean; redemption: RedemptionRow | null }> {
  const { orderId, releasedBy = null } = params;
  const rows = await db.execute<RawRedemption>(sql`
    UPDATE referral_redemptions
    SET status = 'released', released_by = ${releasedBy}, settled_at = now()
    WHERE order_id = ${orderId} AND status IN ('reserved', 'spent')
    RETURNING ${SELECT_COLUMNS}
  `);
  const row = rows[0] ? mapRedemption(rows[0]) : null;
  if (row) {
    log.info({
      event: 'db.referral.bonus_released',
      orderId,
      releasedBy,
      amountUsdCents: row.amountUsdCents,
    });
    emitDbChange('referral_redemptions');
    return { applied: true, redemption: row };
  }
  return { applied: false, redemption: null };
}

/**
 * Системный откат несостоявшегося счёта: `reserved → released`, но ТОЛЬКО пока
 * по заказу нет живого или успешного платежа.
 *
 * ⚠️ Оговорка про платёж — не перестраховка, а закрытая дыра. Два
 * одновременных «Оплатить» по одному заказу: A занимает баллы, B видит чужое
 * занятие, берёт из него скидку и успевает СОЗДАТЬ счёт, после чего A падает
 * на таймауте шлюза и идёт снимать «своё» занятие. Без условия резерв уходит в
 * `released` под живым счётом со скидкой: `claimBonusSpent` на вебхуке не
 * находит `reserved`, списывать нечего — клиент получает скидку бесплатно.
 *
 * Возврат ОПЕРАТОРОМ этой оговорки не имеет и иметь не должен: там платёж как
 * раз успешный, и человек возвращает баллы осознанно.
 */
export async function releaseUnusedBonusReservation(
  db: DBLike,
  orderId: string,
  log: RepoLogger = noopLogger,
): Promise<{ applied: boolean; redemption: RedemptionRow | null }> {
  const rows = await db.execute<RawRedemption>(sql`
    UPDATE referral_redemptions
    SET status = 'released', released_by = NULL, settled_at = now()
    WHERE order_id = ${orderId}
      AND status = 'reserved'
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.order_id = ${orderId} AND p.status IN ('pending', 'succeeded')
      )
    RETURNING ${SELECT_COLUMNS}
  `);
  const row = rows[0] ? mapRedemption(rows[0]) : null;
  if (row) {
    log.info({
      event: 'db.referral.bonus_released',
      orderId,
      releasedBy: null,
      amountUsdCents: row.amountUsdCents,
    });
    emitDbChange('referral_redemptions');
    return { applied: true, redemption: row };
  }
  return { applied: false, redemption: null };
}

/**
 * Зафиксировать списание: `reserved → spent`, at-most-once.
 *
 * Принимает транзакцию, потому что зовётся ВНУТРИ общей транзакции обработки
 * оплаты (рядом с `claimPaymentSucceeded` + `transitionOrder(paid)`) — иначе
 * между «заказ оплачен» и «списание зафиксировано» появилось бы окно, в котором
 * резерв под оплаченным заказом всё ещё выглядит возвращаемым. Ноль строк —
 * идемпотентный повтор вебхука, эффектов нет.
 */
export async function claimBonusSpent(
  tx: DBLike,
  orderId: string,
  log: RepoLogger = noopLogger,
): Promise<RedemptionRow | null> {
  const rows = await tx.execute<RawRedemption>(sql`
    UPDATE referral_redemptions
    SET status = 'spent', settled_at = now()
    WHERE order_id = ${orderId} AND status = 'reserved'
    RETURNING ${SELECT_COLUMNS}
  `);
  const row = rows[0] ? mapRedemption(rows[0]) : null;
  if (row) {
    log.info({
      event: 'db.referral.bonus_spent',
      orderId,
      userId: row.userId,
      amountUsdCents: row.amountUsdCents,
    });
    emitDbChange('referral_redemptions');
  }
  return row;
}

/** Списание по заказу (любого статуса) — для витрин и потолка начисления. */
export async function findRedemptionByOrderId(
  db: DBLike,
  orderId: string,
): Promise<RedemptionRow | null> {
  const rows = await db.execute<RawRedemption>(sql`
    SELECT ${SELECT_COLUMNS} FROM referral_redemptions WHERE order_id = ${orderId}
  `);
  return rows[0] ? mapRedemption(rows[0]) : null;
}

/**
 * Списания пачкой — чтобы список заказов панели не делал запрос на строку.
 * Пустой вход отдаёт пустую карту без похода в базу.
 */
export async function findRedemptionsByOrderIds(
  db: DBLike,
  orderIds: readonly string[],
): Promise<Map<string, RedemptionRow>> {
  if (orderIds.length === 0) return new Map();
  const ids = sql.join(
    orderIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<RawRedemption>(sql`
    SELECT ${SELECT_COLUMNS} FROM referral_redemptions WHERE order_id IN (${ids})
  `);
  return new Map(rows.map((r) => [r.order_id, mapRedemption(r)]));
}

export type StuckBonusOrder = {
  orderId: string;
  shortId: string;
  userId: string;
  amountUsdCents: number;
  discountKopecks: number;
  reservedAt: Date;
};

/**
 * Заказы, где списанные баллы ЖДУТ РЕШЕНИЯ ЧЕЛОВЕКА, — и сторож, и кнопка
 * панели опираются на одно и то же понятие.
 *
 * Такое состояние даёт ровно два пути:
 *
 *  - заказ в `failed` — деньги приняты, выдать не смогли. Автовозврат оттуда
 *    был бы единственным путём к отрицательному балансу клиента (ручная выдача
 *    списала бы баллы повторно), поэтому решает оператор;
 *  - заказ в `expired`/`cancelled`, но с УСПЕШНЫМ платежом — редкий разрыв:
 *    крон похоронил заказ, а оплата пришла следом (`paid_after_terminal`).
 *    Правило автовозврата такие баллы намеренно НЕ возвращает (клиент получил
 *    скидку по оплаченному счёту), и вернуть их может только человек — тот же,
 *    кто разбирается с самими деньгами по этому заказу.
 *
 * Оплатимые статусы сюда не входят: там заказ ещё жив и вернёт баллы сам.
 */
export function isBonusAwaitingDecision(input: {
  orderStatus: string;
  hasSucceededPayment: boolean;
}): boolean {
  if (input.orderStatus === 'failed') return true;
  return (
    (input.orderStatus === 'expired' || input.orderStatus === 'cancelled') &&
    input.hasSucceededPayment
  );
}

/**
 * Сторож (тикет 07): заказы с ЖИВЫМ списанием, ждущим решения, старше
 * `olderThanMs`. Решение может потеряться, поэтому крон о нём напоминает. Порог
 * короче, чем 7 дней у холдов банка: там мы ждём внешнюю систему, здесь только
 * себя.
 *
 * SQL отбирает КАНДИДАТОВ (три терминальных статуса + признак успешного
 * платежа), а решение принимает `isBonusAwaitingDecision` в JS — та же функция,
 * что решает, показывать ли кнопку возврата в панели. Второе условие в SQL было
 * бы зеркалом на денежном пути: сторож молчал бы о том, что оператор видит, или
 * наоборот. Состояние редкое, поэтому лишние строки ничего не стоят.
 */
export async function findOrdersWithStuckBonus(
  db: DBLike,
  input: { olderThanMs: number; limit: number },
): Promise<StuckBonusOrder[]> {
  const cutoff = new Date(Date.now() - input.olderThanMs).toISOString();
  const rows = await db.execute<{
    order_id: string;
    short_id: string;
    user_id: string;
    amount_usd_cents: number;
    discount_kopecks: number;
    reserved_at: string | Date;
    order_status: string;
    has_succeeded_payment: boolean;
  }>(sql`
    SELECT r.order_id, o.short_id, r.user_id, r.amount_usd_cents, r.discount_kopecks,
           r.reserved_at, o.status AS order_status,
           EXISTS (
             SELECT 1 FROM payments p WHERE p.order_id = r.order_id AND p.status = 'succeeded'
           ) AS has_succeeded_payment
    FROM referral_redemptions r
    JOIN orders o ON o.id = r.order_id
    WHERE o.status IN ('failed', 'expired', 'cancelled')
      AND r.status IN ('reserved', 'spent')
      AND r.reserved_at < ${cutoff}
    ORDER BY r.reserved_at ASC
    LIMIT ${input.limit}
  `);
  return rows
    .filter((r) =>
      isBonusAwaitingDecision({
        orderStatus: r.order_status,
        hasSucceededPayment: r.has_succeeded_payment,
      }),
    )
    .map((r) => ({
      orderId: r.order_id,
      shortId: r.short_id,
      userId: r.user_id,
      amountUsdCents: Number(r.amount_usd_cents),
      discountKopecks: Number(r.discount_kopecks),
      reservedAt: new Date(r.reserved_at),
    }));
}

/**
 * Сколько рублей выручки погашено баллами за период (отчёты `/admin/analytics`,
 * решение Q8). Считаем только `spent`: резерв деньгами ещё не стал, а
 * возвращённое списание выручку не гасило.
 *
 * Окно — по `settled_at` (момент оплаты), полуоткрытое `[since, until)`, как у
 * остальных выборок отчёта.
 *
 * ⚠️ `Date` в raw-`sql` не передаём — только ISO-строку: postgres-js на проде
 * падает `TypeError … Received an instance of Date`, а PGlite в тестах `Date`
 * переваривает, и регресс невидим в зелёном прогоне (инцидент 2026-08-15).
 */
export async function sumBonusRedeemedKopecks(
  db: DBLike,
  input: { since: Date; until: Date },
): Promise<{ discountKopecks: number; orders: number }> {
  const rows = await db.execute<{ discount: string | number; orders: string | number }>(sql`
    SELECT COALESCE(SUM(discount_kopecks), 0)::bigint AS discount, COUNT(*)::bigint AS orders
    FROM referral_redemptions
    WHERE status = 'spent'
      AND settled_at >= ${input.since.toISOString()}
      AND settled_at < ${input.until.toISOString()}
  `);
  return {
    discountKopecks: Number(rows[0]?.discount ?? 0),
    orders: Number(rows[0]?.orders ?? 0),
  };
}

export type SelfReferralMatch = {
  /** По какому признаку совпало: почта, нормализованный телефон или последний IP. */
  signal: 'email' | 'phone' | 'ip';
  /** Кто пригласил (владелец баланса) и кого. */
  partnerUserId: string;
  referralUserId: string;
};

/**
 * Эвристика самореферала (E3-lite, решение Q6): совпадают ли контакты партнёра
 * с контактами кого-то из ПРИГЛАШЁННЫХ им.
 *
 * Списание баллов впервые делает баланс настоящими деньгами и включает
 * выгодность мультиаккаунта: второй аккаунт даёт кэшбэк на собственных
 * покупках. Маржа 30% это переживает, но знать об этом надо.
 *
 * ⚠️ Только СИГНАЛ, без автоблока: совпадение IP — это ещё и семья, и наш
 * собственный VPN, и один мобильный оператор за CGNAT. Решение принимает
 * человек через `referral_partners.suspended`.
 *
 * NULL совпадением не считается (`IS NOT NULL` у обеих сторон): иначе два
 * клиента без телефона выглядели бы одним человеком. Телефон сравнивается по
 * ЦИФРАМ: приложение хранит его нормализованным (`normalizePhone` приводит к
 * `+7…`), но легаси-строка с разделителями не совпала бы сама с собой по `=`.
 *
 * ⚠️ Класс `[^0-9]`, а НЕ `\D`: SQL здесь живёт в шаблонной строке JS, где
 * `\D` схлопывается в букву `D` — регэксп молча начинал вырезать из номера
 * буквы `D` вместо разделителей, и сверка не находила ничего (поймано тестом).
 */
export async function findSelfReferralSignals(
  db: DBLike,
  partnerUserId: string,
): Promise<SelfReferralMatch[]> {
  const rows = await db.execute<{ signal: string; referral_user_id: string }>(sql`
    SELECT signal, referral_user_id FROM (
      SELECT 'email' AS signal, r.id AS referral_user_id
      FROM users p JOIN users r ON r.referred_by = p.id
      WHERE p.id = ${partnerUserId}
        AND p.email IS NOT NULL AND r.email IS NOT NULL
        AND lower(p.email) = lower(r.email)
      UNION ALL
      SELECT 'phone', r.id
      FROM users p JOIN users r ON r.referred_by = p.id
      WHERE p.id = ${partnerUserId}
        AND p.phone IS NOT NULL AND r.phone IS NOT NULL
        AND regexp_replace(p.phone, '[^0-9]', '', 'g') <> ''
        AND regexp_replace(p.phone, '[^0-9]', '', 'g') = regexp_replace(r.phone, '[^0-9]', '', 'g')
      UNION ALL
      SELECT 'ip', r.id
      FROM users p JOIN users r ON r.referred_by = p.id
      WHERE p.id = ${partnerUserId}
        AND p.last_seen_ip IS NOT NULL AND r.last_seen_ip IS NOT NULL
        AND p.last_seen_ip = r.last_seen_ip
    ) s
    LIMIT 50
  `);
  return rows.map((r) => ({
    signal: r.signal as SelfReferralMatch['signal'],
    partnerUserId,
    referralUserId: r.referral_user_id,
  }));
}
