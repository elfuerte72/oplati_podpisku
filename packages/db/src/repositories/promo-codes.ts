import { sql } from 'drizzle-orm';

import type { DB, DBLike } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';
import { livePromoRedemptionSql } from './promo-redemption-sql.ts';

/**
 * Промокоды: правила кода и состояние его применения к заказу (трек promo-codes).
 *
 * Примитивы доступа к БД, без money-math: репозиторий принимает УЖЕ посчитанные
 * копейки (`apps/web/lib/promo/math.ts`), а решает здесь только вопросы
 * состояния, лимитов и гонок.
 *
 * `promo_redemptions` — состояние, а не журнал: одна строка на заказ
 * (`order_id` PK), статус движется `reserved → spent | released`. Аудит-след
 * живёт отдельно строками `order_events` (append-only).
 *
 * ⚠️ `emitDbChange` здесь НЕ зовётся — это осознанный пропуск, а не забытая
 * строка. Лента изменений питает живое обновление панели, а панель промокоды не
 * показывает: сумма счёта на её экранах приходит из `payments`, и та в ленте
 * уже есть. Появится раздел промокодов — вместе с ним добавить таблицу в
 * `DB_CHANGE_TABLES` и строку в `PANEL_LIVE_SECTIONS_BY_TABLE` (вторую ловит
 * typecheck, первую — нет).
 */

export type PromoRedemptionStatus = 'reserved' | 'spent' | 'released';

export type PromoCodeRow = {
  id: string;
  code: string;
  discountUsdCents: number;
  capToMargin: boolean;
  minOrderAmountKopecks: number | null;
  perUserLimit: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  note: string | null;
  createdAt: Date;
};

type RawPromoCode = {
  id: string;
  code: string;
  discount_usd_cents: number;
  cap_to_margin: boolean;
  min_order_amount_kopecks: number | null;
  per_user_limit: number;
  max_redemptions: number | null;
  starts_at: string | Date | null;
  expires_at: string | Date | null;
  is_active: boolean;
  note: string | null;
  created_at: string | Date;
};

function mapPromoCode(r: RawPromoCode): PromoCodeRow {
  return {
    id: r.id,
    code: r.code,
    discountUsdCents: Number(r.discount_usd_cents),
    capToMargin: r.cap_to_margin,
    minOrderAmountKopecks:
      r.min_order_amount_kopecks === null ? null : Number(r.min_order_amount_kopecks),
    perUserLimit: Number(r.per_user_limit),
    maxRedemptions: r.max_redemptions === null ? null : Number(r.max_redemptions),
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    isActive: r.is_active,
    note: r.note,
    createdAt: new Date(r.created_at),
  };
}

export type PromoRedemptionRow = {
  orderId: string;
  promoCodeId: string;
  userId: string;
  discountUsdCents: number;
  discountKopecks: number;
  rateKopecks: number;
  status: PromoRedemptionStatus;
  releasedBy: string | null;
  reservedAt: Date;
  settledAt: Date | null;
};

type RawPromoRedemption = {
  order_id: string;
  promo_code_id: string;
  user_id: string;
  discount_usd_cents: number;
  discount_kopecks: number;
  rate_kopecks: number;
  status: PromoRedemptionStatus;
  released_by: string | null;
  reserved_at: string | Date;
  settled_at: string | Date | null;
};

function mapPromoRedemption(r: RawPromoRedemption): PromoRedemptionRow {
  return {
    orderId: r.order_id,
    promoCodeId: r.promo_code_id,
    userId: r.user_id,
    discountUsdCents: Number(r.discount_usd_cents),
    discountKopecks: Number(r.discount_kopecks),
    rateKopecks: Number(r.rate_kopecks),
    status: r.status,
    releasedBy: r.released_by,
    reservedAt: new Date(r.reserved_at),
    settledAt: r.settled_at ? new Date(r.settled_at) : null,
  };
}

const CODE_COLUMNS = sql`
  id, code, discount_usd_cents, cap_to_margin, min_order_amount_kopecks,
  per_user_limit, max_redemptions, starts_at, expires_at, is_active, note, created_at
`;

const REDEMPTION_COLUMNS = sql`
  order_id, promo_code_id, user_id, discount_usd_cents, discount_kopecks,
  rate_kopecks, status, released_by, reserved_at, settled_at
`;

/**
 * Найти код по УЖЕ нормализованному написанию (`normalizePromoCode`).
 *
 * Выключенный код (`is_active=false`) возвращается тоже: решение «показать
 * клиенту "нет такого кода"» принимает слой гейтов, и различать выключенный код
 * от несуществующего нужно ему для логов. Клиенту оба выглядят одинаково —
 * иначе перебор кодов отвечал бы, какие из них существуют.
 */
export async function findPromoCodeByCode(
  db: DBLike,
  code: string,
): Promise<PromoCodeRow | null> {
  const rows = await db.execute<RawPromoCode>(sql`
    SELECT ${CODE_COLUMNS} FROM promo_codes WHERE code = ${code} LIMIT 1
  `);
  return rows[0] ? mapPromoCode(rows[0]) : null;
}

/**
 * Сколько раз клиент УЖЕ израсходовал этот код, и сколько израсходовано всего.
 *
 * Оба счётчика — по одному выражению `livePromoRedemptionSql`: вернувшееся
 * право не считается использованным ни в личном лимите, ни в общем.
 *
 * JOIN с `orders` обязателен — правило «живо» смотрит на статус заказа.
 */
export async function countPromoRedemptions(
  db: DBLike,
  params: { promoCodeId: string; userId: string },
): Promise<{ byUser: number; total: number }> {
  const { promoCodeId, userId } = params;
  const rows = await db.execute<{ by_user: string | number; total: string | number }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE pr.user_id = ${userId}) AS by_user,
      COUNT(*) AS total
    FROM promo_redemptions pr
    JOIN orders o ON o.id = pr.order_id
    WHERE pr.promo_code_id = ${promoCodeId}
      AND ${livePromoRedemptionSql(sql`pr`, sql`o`)}
  `);
  return {
    byUser: Number(rows[0]?.by_user ?? 0),
    total: Number(rows[0]?.total ?? 0),
  };
}

export type ReservePromoResult =
  | { ok: true }
  /** Личный лимит клиента исчерпан. */
  | { ok: false; reason: 'already_used' }
  /** Общий лимит активаций кода исчерпан. */
  | { ok: false; reason: 'exhausted' }
  /**
   * Под этот заказ промокод уже занят — и это НЕ отказ по смыслу: строка
   * принадлежит тому же заказу, просто заняла её другая попытка (двойной тап,
   * вторая вкладка). Вызывающий обязан взять скидку ИЗ НЕЁ, а не из своего
   * свежего расчёта: счёт должен уйти на ту сумму, которая реально занята.
   */
  | { ok: false; reason: 'already_reserved'; existing: PromoRedemptionRow };

/**
 * Занять промокод под заказ.
 *
 * ⚠️ ДВА лока, и порядок между ними фиксирован — сначала код, потом клиент:
 *
 *  - `hashtext('promo:' || promoCodeId)` защищает ОБЩИЙ лимит активаций: без
 *    него два разных клиента одновременно видят «осталась одна» и забирают обе;
 *  - `hashtext(userId)` — ТОТ ЖЕ КЛЮЧ, что у списания баллов и заявки на вывод.
 *    Он защищает личный лимит («один раз на клиента») от двух параллельных
 *    заказов одного человека и заодно сериализует промокод с баллами, которые
 *    тратят маржу того же заказа.
 *
 * Порядок «код → клиент» соблюдается ВСЕГДА, даже когда общего лимита нет:
 * взятие локов в разном порядке разными транзакциями — классический дедлок, и
 * условная блокировка была бы ровно таким разнобоем. Баллы берут только второй
 * лок, поэтому с ними цикла не образуется.
 *
 * Идемпотентность — `order_id` первичным ключом. Строку, снятую СИСТЕМНЫМ
 * откатом (`released`), занятие воскрешает: `payments/create` снимает занятие в
 * `catch`, и без воскрешения повторная попытка оплатить тот же заказ навсегда
 * теряла бы право на скидку.
 */
export async function reservePromoForOrder(
  db: DB,
  params: {
    orderId: string;
    promoCodeId: string;
    userId: string;
    discountUsdCents: number;
    discountKopecks: number;
    rateKopecks: number;
    perUserLimit: number;
    maxRedemptions: number | null;
  },
  log: RepoLogger = noopLogger,
): Promise<ReservePromoResult> {
  const {
    orderId,
    promoCodeId,
    userId,
    discountUsdCents,
    discountKopecks,
    rateKopecks,
    perUserLimit,
    maxRedemptions,
  } = params;
  if (discountKopecks <= 0 || discountUsdCents <= 0) {
    throw new Error('reservePromoForOrder: скидка должна быть положительной');
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`promo:${promoCodeId}`})::bigint)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);

    const existingRows = await tx.execute<RawPromoRedemption>(sql`
      SELECT ${REDEMPTION_COLUMNS} FROM promo_redemptions WHERE order_id = ${orderId}
    `);
    const existing = existingRows[0] ? mapPromoRedemption(existingRows[0]) : null;
    if (existing && existing.status !== 'released') {
      return { ok: false as const, reason: 'already_reserved' as const, existing };
    }

    // Счётчики читаются ВНУТРИ лока: расчёт снаружи мог устареть, а именно на
    // этом числе держится «один раз на клиента».
    const countRows = await tx.execute<{ by_user: string | number; total: string | number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE pr.user_id = ${userId}) AS by_user,
        COUNT(*) AS total
      FROM promo_redemptions pr
      JOIN orders o ON o.id = pr.order_id
      WHERE pr.promo_code_id = ${promoCodeId}
        AND pr.order_id <> ${orderId}
        AND ${livePromoRedemptionSql(sql`pr`, sql`o`)}
    `);
    const byUser = Number(countRows[0]?.by_user ?? 0);
    const total = Number(countRows[0]?.total ?? 0);

    if (byUser >= perUserLimit) return { ok: false as const, reason: 'already_used' as const };
    if (maxRedemptions !== null && total >= maxRedemptions) {
      return { ok: false as const, reason: 'exhausted' as const };
    }

    if (existing) {
      // Воскрешение снятого системой занятия: та же строка, свежие числа,
      // автор возврата и отметка закрытия сбрасываются.
      await tx.execute(sql`
        UPDATE promo_redemptions
        SET promo_code_id = ${promoCodeId},
            discount_usd_cents = ${discountUsdCents},
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
        INSERT INTO promo_redemptions
          (order_id, promo_code_id, user_id, discount_usd_cents, discount_kopecks, rate_kopecks, status)
        VALUES (${orderId}, ${promoCodeId}, ${userId}, ${discountUsdCents}, ${discountKopecks}, ${rateKopecks}, 'reserved')
        ON CONFLICT (order_id) DO NOTHING
      `);
    }

    return { ok: true as const };
  });

  if (result.ok) {
    log.info({ event: 'db.promo.reserved', orderId, promoCodeId, userId, discountKopecks });
  }
  return result;
}

/**
 * Снять занятие, если счёт по заказу так и не создан (системный откат).
 *
 * ⚠️ Занятие под УЖЕ созданным счётом не снимается — условие живёт здесь, а не
 * у вызывающего: параллельная попытка того же заказа могла успеть выставить
 * счёт со скидкой, и освобождение отдало бы клиенту скидку бесплатно. То же
 * правило, что у `releaseUnusedBonusReservation`.
 *
 * «Счёт создан» = у заказа есть платёж в `pending` или `succeeded`. `failed`
 * счётом не считается: по нему денег не пришло, и повторная попытка оплаты
 * должна получить право на скидку обратно.
 */
export async function releaseUnusedPromoReservation(
  db: DBLike,
  orderId: string,
  log: RepoLogger = noopLogger,
): Promise<{ applied: boolean; redemption: PromoRedemptionRow | null }> {
  const rows = await db.execute<RawPromoRedemption>(sql`
    UPDATE promo_redemptions
    SET status = 'released', settled_at = now()
    WHERE order_id = ${orderId}
      AND status = 'reserved'
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.order_id = ${orderId} AND p.status IN ('pending', 'succeeded')
      )
    RETURNING ${REDEMPTION_COLUMNS}
  `);
  const redemption = rows[0] ? mapPromoRedemption(rows[0]) : null;
  if (redemption) {
    log.info({ event: 'db.promo.released_unused', orderId });
  }
  return { applied: redemption !== null, redemption };
}

/**
 * Вернуть право на промокод РЕШЕНИЕМ ЧЕЛОВЕКА: `reserved|spent → released`.
 *
 * Условный UPDATE, поэтому повтор идемпотентен (`applied:false` — «уже
 * вернули», а не ошибка). Живой счёт этой функции не помеха: оператор
 * возвращает право по заказу, где деньги как раз приняты и не сработали.
 */
export async function releasePromoRedemption(
  db: DBLike,
  params: { orderId: string; releasedBy?: string | null },
  log: RepoLogger = noopLogger,
): Promise<{ applied: boolean; redemption: PromoRedemptionRow | null }> {
  const { orderId, releasedBy = null } = params;
  const rows = await db.execute<RawPromoRedemption>(sql`
    UPDATE promo_redemptions
    SET status = 'released', released_by = ${releasedBy}, settled_at = now()
    WHERE order_id = ${orderId} AND status IN ('reserved', 'spent')
    RETURNING ${REDEMPTION_COLUMNS}
  `);
  const redemption = rows[0] ? mapPromoRedemption(rows[0]) : null;
  if (redemption) {
    log.info({ event: 'db.promo.released', orderId, releasedBy });
  }
  return { applied: redemption !== null, redemption };
}

/**
 * Зафиксировать расход промокода при оплате: `reserved → spent`.
 *
 * Зовётся из `processInvoicePaid` В ТОЙ ЖЕ транзакции, что claim платежа и
 * переход заказа в `paid`. Условный UPDATE делает повтор безопасным, а
 * `null`-возврат означает «нечего фиксировать» (промокода не было или его уже
 * зафиксировали) — не ошибку.
 */
export async function claimPromoSpent(
  db: DBLike,
  orderId: string,
  log: RepoLogger = noopLogger,
): Promise<PromoRedemptionRow | null> {
  const rows = await db.execute<RawPromoRedemption>(sql`
    UPDATE promo_redemptions
    SET status = 'spent', settled_at = now()
    WHERE order_id = ${orderId} AND status = 'reserved'
    RETURNING ${REDEMPTION_COLUMNS}
  `);
  const redemption = rows[0] ? mapPromoRedemption(rows[0]) : null;
  if (redemption) {
    log.info({ event: 'db.promo.spent', orderId, discountKopecks: redemption.discountKopecks });
  }
  return redemption;
}

/** Применение промокода по заказу — витринам и расчёту суммы счёта. */
export async function findPromoRedemptionByOrderId(
  db: DBLike,
  orderId: string,
): Promise<PromoRedemptionRow | null> {
  const rows = await db.execute<RawPromoRedemption>(sql`
    SELECT ${REDEMPTION_COLUMNS} FROM promo_redemptions WHERE order_id = ${orderId}
  `);
  return rows[0] ? mapPromoRedemption(rows[0]) : null;
}

/**
 * Применения промокода ПАЧКОЙ по списку заказов — снапшоту кабинета.
 *
 * Отдельная функция, а не вызов в цикле: блок «Ждут оплаты» показывает строку
 * скидки у каждого заказа, и запрос на заказ превратил бы снапшот в N+1.
 */
export async function findPromoRedemptionsByOrderIds(
  db: DBLike,
  orderIds: readonly string[],
): Promise<Map<string, PromoRedemptionRow>> {
  if (orderIds.length === 0) return new Map();
  const ids = sql.join(
    orderIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<RawPromoRedemption>(sql`
    SELECT ${REDEMPTION_COLUMNS} FROM promo_redemptions WHERE order_id IN (${ids})
  `);
  return new Map(rows.map((r) => [r.order_id, mapPromoRedemption(r)]));
}

/**
 * Сводка по коду для скрипта статистики: сколько активаций израсходовано и на
 * какую сумму. Считает по тому же выражению «живо», что и лимиты, — число на
 * экране владельца обязано совпадать с тем, по которому код перестаёт работать.
 */
export async function summarizePromoCode(
  db: DBLike,
  promoCodeId: string,
): Promise<{ redemptions: number; discountKopecks: number }> {
  const rows = await db.execute<{
    redemptions: string | number;
    discount_kopecks: string | number | null;
  }>(sql`
    SELECT COUNT(*) AS redemptions, COALESCE(SUM(pr.discount_kopecks), 0) AS discount_kopecks
    FROM promo_redemptions pr
    JOIN orders o ON o.id = pr.order_id
    WHERE pr.promo_code_id = ${promoCodeId}
      AND ${livePromoRedemptionSql(sql`pr`, sql`o`)}
  `);
  return {
    redemptions: Number(rows[0]?.redemptions ?? 0),
    discountKopecks: Number(rows[0]?.discount_kopecks ?? 0),
  };
}

/** Все коды — скрипту `db:promo list`. */
export async function listPromoCodes(db: DBLike): Promise<PromoCodeRow[]> {
  const rows = await db.execute<RawPromoCode>(sql`
    SELECT ${CODE_COLUMNS} FROM promo_codes ORDER BY created_at DESC
  `);
  return rows.map(mapPromoCode);
}

/**
 * Завести или обновить код — скрипту `db:promo add`.
 *
 * `ON CONFLICT (code)` намеренно обновляет правила, а не падает: заводя код
 * второй раз, владелец правит акцию, и заставлять его сначала удалять строку
 * значило бы подталкивать к `DELETE` на таблице, на которую ссылаются
 * применения (там `RESTRICT`, и удалить не вышло бы).
 */
export async function upsertPromoCode(
  db: DBLike,
  params: {
    code: string;
    discountUsdCents: number;
    capToMargin: boolean;
    minOrderAmountKopecks: number | null;
    perUserLimit: number;
    maxRedemptions: number | null;
    startsAt: Date | null;
    expiresAt: Date | null;
    isActive: boolean;
    note: string | null;
  },
  log: RepoLogger = noopLogger,
): Promise<PromoCodeRow> {
  const rows = await db.execute<RawPromoCode>(sql`
    INSERT INTO promo_codes
      (code, discount_usd_cents, cap_to_margin, min_order_amount_kopecks,
       per_user_limit, max_redemptions, starts_at, expires_at, is_active, note)
    VALUES (
      ${params.code}, ${params.discountUsdCents}, ${params.capToMargin},
      ${params.minOrderAmountKopecks}, ${params.perUserLimit}, ${params.maxRedemptions},
      ${params.startsAt ? params.startsAt.toISOString() : null},
      ${params.expiresAt ? params.expiresAt.toISOString() : null},
      ${params.isActive}, ${params.note}
    )
    ON CONFLICT (code) DO UPDATE SET
      discount_usd_cents = EXCLUDED.discount_usd_cents,
      cap_to_margin = EXCLUDED.cap_to_margin,
      min_order_amount_kopecks = EXCLUDED.min_order_amount_kopecks,
      per_user_limit = EXCLUDED.per_user_limit,
      max_redemptions = EXCLUDED.max_redemptions,
      starts_at = EXCLUDED.starts_at,
      expires_at = EXCLUDED.expires_at,
      is_active = EXCLUDED.is_active,
      note = EXCLUDED.note
    RETURNING ${CODE_COLUMNS}
  `);
  const row = rows[0];
  if (!row) throw new Error('upsertPromoCode: пустой RETURNING');
  log.info({ event: 'db.promo.upserted', code: params.code });
  return mapPromoCode(row);
}

/** Включить или выключить код — скрипту `db:promo enable|disable`. */
export async function setPromoCodeActive(
  db: DBLike,
  params: { code: string; isActive: boolean },
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE promo_codes SET is_active = ${params.isActive}
    WHERE code = ${params.code}
    RETURNING id
  `);
  const applied = rows.length > 0;
  if (applied) log.info({ event: 'db.promo.active_changed', code: params.code, isActive: params.isActive });
  return applied;
}
