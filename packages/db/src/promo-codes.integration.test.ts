import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { normalizePromoCode } from '@oplati/types';

import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import {
  claimPromoSpent,
  countPromoRedemptions,
  findPromoCodeByCode,
  findPromoRedemptionByOrderId,
  findPromoRedemptionsByOrderIds,
  releasePromoRedemption,
  releaseUnusedPromoReservation,
  reservePromoForOrder,
  setPromoCodeActive,
  summarizePromoCode,
  upsertPromoCode,
} from './repositories/promo-codes.ts';

/**
 * Интеграционные тесты промокодов (трек promo-codes) — РЕАЛЬНЫЙ Postgres
 * (PGlite) с РЕАЛЬНЫМИ миграциями: атомарность занятия под advisory-локами,
 * check-констрейнты и правило «живое применение» (оно смотрит на статус заказа
 * и наличие успешного платежа) иначе не проверить.
 */

let db: DB;

beforeAll(async () => {
  ({ db } = await createTestDb());
});

let seq = 0;

async function createUser(): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `promo-tg-${++seq}` })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

async function createOrder(userId: string): Promise<string> {
  const order = await createDraftOrder(db, {
    userId,
    status: 'ready_for_payment',
    customServiceDescription: 'promo-test order',
  });
  return order.id;
}

/** Статус заказа меняем прямым UPDATE — это аранжировка, а не путь продукта. */
async function setOrderStatus(orderId: string, status: string): Promise<void> {
  await db.execute(sql`UPDATE orders SET status = ${status}::order_status WHERE id = ${orderId}`);
}

async function addSucceededPayment(orderId: string): Promise<void> {
  await db.insert(schema.payments).values({
    orderId,
    provider: 'freekassa',
    providerRef: `promo-pay-${++seq}`,
    amountRub: 100_00,
    status: 'succeeded',
  });
}

async function addPendingPayment(orderId: string): Promise<void> {
  await db.insert(schema.payments).values({
    orderId,
    provider: 'freekassa',
    providerRef: `promo-pay-${++seq}`,
    amountRub: 100_00,
    status: 'pending',
  });
}

async function makeCode(
  over: Partial<Parameters<typeof upsertPromoCode>[1]> = {},
): Promise<{ id: string; code: string }> {
  const code = over.code ?? `ТЕСТКОД${++seq}`;
  const row = await upsertPromoCode(db, {
    code,
    discountUsdCents: 500,
    capToMargin: false,
    minOrderAmountKopecks: null,
    perUserLimit: 1,
    maxRedemptions: null,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    note: null,
    ...over,
  });
  return { id: row.id, code: row.code };
}

const RESERVE_ARGS = { discountUsdCents: 500, discountKopecks: 405_00, rateKopecks: 81_0000 };

describe('promo_codes — заведение и поиск', () => {
  it('заводит код и находит его по написанию', async () => {
    const { code } = await makeCode({ code: 'ДАРЛИНГ' });
    const found = await findPromoCodeByCode(db, code);
    expect(found).toMatchObject({
      code: 'ДАРЛИНГ',
      discountUsdCents: 500,
      capToMargin: false,
      perUserLimit: 1,
    });
  });

  it('повторное заведение того же кода ОБНОВЛЯЕТ правила, а не падает', async () => {
    const { id } = await makeCode({ code: 'ОБНОВЛЯЕМЫЙ', discountUsdCents: 500 });
    const again = await upsertPromoCode(db, {
      code: 'ОБНОВЛЯЕМЫЙ',
      discountUsdCents: 1000,
      capToMargin: true,
      minOrderAmountKopecks: 2000_00,
      perUserLimit: 3,
      maxRedemptions: 50,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      note: 'правка акции',
    });
    // Та же строка: применения по FK никуда не делись.
    expect(again.id).toBe(id);
    expect(again).toMatchObject({
      discountUsdCents: 1000,
      capToMargin: true,
      minOrderAmountKopecks: 2000_00,
      perUserLimit: 3,
      maxRedemptions: 50,
    });
  });

  it('выключение кода видно через findPromoCodeByCode (решает слой гейтов)', async () => {
    const { code } = await makeCode();
    expect(await setPromoCodeActive(db, { code, isActive: false })).toBe(true);
    const found = await findPromoCodeByCode(db, code);
    expect(found?.isActive).toBe(false);
  });

  it('несуществующий код — null, а не ошибка', async () => {
    expect(await findPromoCodeByCode(db, 'НЕТТАКОГО')).toBeNull();
  });

  it('CHECK не пускает неположительный номинал', async () => {
    await expect(makeCode({ discountUsdCents: 0 })).rejects.toThrow();
  });

  it('CHECK не пускает нулевой личный лимит', async () => {
    await expect(makeCode({ perUserLimit: 0 })).rejects.toThrow();
  });

  it('CHECK не пускает окно, где конец раньше начала', async () => {
    await expect(
      makeCode({
        startsAt: new Date('2026-10-01T00:00:00Z'),
        expiresAt: new Date('2026-09-01T00:00:00Z'),
      }),
    ).rejects.toThrow();
  });
});

/**
 * Смоук сквозного пути «владелец завёл код → клиент его набрал».
 *
 * Держится на том, что нормализация ОДНА (`normalizePromoCode` из
 * `@oplati/types`): её зовёт и скрипт `db:promo add`, и разбор тела запроса
 * кабинета. Разъедутся — заведённый код просто не найдётся, а отладить это
 * можно будет только hex-дампом.
 */
describe('сквозной путь: заведён скриптом — найден по вводу клиента', () => {
  it('ДАРЛИНГ находится при любом написании', async () => {
    // Ровно то, что делает `db:promo add ДАРЛИНГ 5`.
    const created = await upsertPromoCode(db, {
      code: normalizePromoCode('ДАРЛИНГ'),
      discountUsdCents: 500,
      capToMargin: false,
      minOrderAmountKopecks: null,
      perUserLimit: 1,
      maxRedemptions: null,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      note: 'первый промокод',
    });

    for (const typed of ['ДАРЛИНГ', 'дарлинг', ' дaрлинг ', 'ДАР-ЛИНГ', 'дAр линг']) {
      const found = await findPromoCodeByCode(db, normalizePromoCode(typed));
      expect(found?.id, `ввод "${typed}"`).toBe(created.id);
    }
  });
});

describe('reservePromoForOrder — занятие и лимиты', () => {
  it('занимает промокод под заказ', async () => {
    const userId = await createUser();
    const orderId = await createOrder(userId);
    const { id: promoCodeId } = await makeCode();

    const result = await reservePromoForOrder(db, {
      orderId,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    expect(result).toEqual({ ok: true });

    const row = await findPromoRedemptionByOrderId(db, orderId);
    expect(row).toMatchObject({
      orderId,
      promoCodeId,
      userId,
      status: 'reserved',
      discountKopecks: 405_00,
      discountUsdCents: 500,
    });
  });

  it('повтор по тому же заказу — already_reserved с СУЩЕСТВУЮЩЕЙ строкой', async () => {
    const userId = await createUser();
    const orderId = await createOrder(userId);
    const { id: promoCodeId } = await makeCode();
    const args = { orderId, promoCodeId, userId, ...RESERVE_ARGS, perUserLimit: 1, maxRedemptions: null };

    await reservePromoForOrder(db, args);
    // Вторая попытка приходит с ДРУГОЙ суммой — вернуться должна первая.
    const second = await reservePromoForOrder(db, { ...args, discountKopecks: 999_00 });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toBe('already_reserved');
    if (second.reason !== 'already_reserved') throw new Error('unreachable');
    expect(second.existing.discountKopecks).toBe(405_00);
  });

  it('личный лимит: второй заказ того же клиента получает already_used', async () => {
    const userId = await createUser();
    const { id: promoCodeId } = await makeCode({ perUserLimit: 1 });
    const first = await createOrder(userId);
    const second = await createOrder(userId);

    await reservePromoForOrder(db, {
      orderId: first,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    const result = await reservePromoForOrder(db, {
      orderId: second,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    expect(result).toEqual({ ok: false, reason: 'already_used' });
  });

  it('личный лимит 2 пускает второй заказ и режет третий', async () => {
    const userId = await createUser();
    const { id: promoCodeId } = await makeCode({ perUserLimit: 2 });
    const args = { promoCodeId, userId, ...RESERVE_ARGS, perUserLimit: 2, maxRedemptions: null };

    expect(await reservePromoForOrder(db, { ...args, orderId: await createOrder(userId) })).toEqual({
      ok: true,
    });
    expect(await reservePromoForOrder(db, { ...args, orderId: await createOrder(userId) })).toEqual({
      ok: true,
    });
    expect(await reservePromoForOrder(db, { ...args, orderId: await createOrder(userId) })).toEqual({
      ok: false,
      reason: 'already_used',
    });
  });

  it('общий лимит активаций режет ДРУГОГО клиента', async () => {
    const { id: promoCodeId } = await makeCode({ maxRedemptions: 1 });
    const userA = await createUser();
    const userB = await createUser();

    await reservePromoForOrder(db, {
      orderId: await createOrder(userA),
      promoCodeId,
      userId: userA,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: 1,
    });
    const result = await reservePromoForOrder(db, {
      orderId: await createOrder(userB),
      promoCodeId,
      userId: userB,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('пачка попыток одного клиента не пробивает личный лимит', async () => {
    // ⚠️ ЭТО НЕ ПРОВЕРКА ЛОКА. PGlite работает на ОДНОМ соединении, поэтому
    // `Promise.all` транзакций здесь сериализуется, и настоящей гонки не
    // возникает: удаление обоих `pg_advisory_xact_lock` оставляет этот файл
    // полностью зелёным (проверено мутацией на ревью 2026-09-11).
    //
    // Тест всё равно ценен — он ловит логику лимита (что второй заказ получает
    // отказ, а не молча вторую скидку), но за САМИ локи отвечает канарейка
    // `promo-locks.test.ts`. Настоящая параллельность проверяется только на
    // живом Postgres — это известная слепая зона PGlite, описанная в
    // `docs/reference/testing.md`.
    const userId = await createUser();
    const { id: promoCodeId } = await makeCode({ perUserLimit: 1 });
    const orders = [await createOrder(userId), await createOrder(userId), await createOrder(userId)];

    const results = await Promise.all(
      orders.map((orderId) =>
        reservePromoForOrder(db, {
          orderId,
          promoCodeId,
          userId,
          ...RESERVE_ARGS,
          perUserLimit: 1,
          maxRedemptions: null,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('пачка попыток разных клиентов не пробивает общий лимит', async () => {
    // Та же оговорка, что и выше: на PGlite это проверка ЛОГИКИ общего лимита,
    // а не лока по промокоду. За лок отвечает `promo-locks.test.ts`.
    const { id: promoCodeId } = await makeCode({ maxRedemptions: 2 });
    const users = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    const pairs = await Promise.all(
      users.map(async (userId) => ({ userId, orderId: await createOrder(userId) })),
    );

    const results = await Promise.all(
      pairs.map(({ userId, orderId }) =>
        reservePromoForOrder(db, {
          orderId,
          promoCodeId,
          userId,
          ...RESERVE_ARGS,
          perUserLimit: 1,
          maxRedemptions: 2,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it('неположительная скидка — программная ошибка, а не тихая строка', async () => {
    const userId = await createUser();
    const orderId = await createOrder(userId);
    const { id: promoCodeId } = await makeCode();
    await expect(
      reservePromoForOrder(db, {
        orderId,
        promoCodeId,
        userId,
        discountUsdCents: 500,
        discountKopecks: 0,
        rateKopecks: 81_0000,
        perUserLimit: 1,
        maxRedemptions: null,
      }),
    ).rejects.toThrow();
  });
});

describe('жизненный цикл применения', () => {
  async function reserved(): Promise<{ userId: string; orderId: string; promoCodeId: string }> {
    const userId = await createUser();
    const orderId = await createOrder(userId);
    const { id: promoCodeId } = await makeCode();
    await reservePromoForOrder(db, {
      orderId,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    return { userId, orderId, promoCodeId };
  }

  it('claimPromoSpent переводит reserved → spent и идемпотентен', async () => {
    const { orderId } = await reserved();
    const first = await claimPromoSpent(db, orderId);
    expect(first?.status).toBe('spent');
    // Повтор вебхука: строка уже spent, возвращается null — не ошибка.
    expect(await claimPromoSpent(db, orderId)).toBeNull();
  });

  it('releaseUnusedPromoReservation снимает занятие, пока счёта нет', async () => {
    const { orderId } = await reserved();
    const { applied, redemption } = await releaseUnusedPromoReservation(db, orderId);
    expect(applied).toBe(true);
    expect(redemption?.status).toBe('released');
  });

  it('⚠️ занятие под ЖИВЫМ счётом системный откат НЕ снимает', async () => {
    // Иначе параллельная попытка того же заказа, успевшая выставить счёт со
    // скидкой, отдала бы клиенту скидку бесплатно.
    const { orderId } = await reserved();
    await addPendingPayment(orderId);
    const { applied } = await releaseUnusedPromoReservation(db, orderId);
    expect(applied).toBe(false);
    expect((await findPromoRedemptionByOrderId(db, orderId))?.status).toBe('reserved');
  });

  it('занятие под ОПЛАЧЕННЫМ заказом системный откат тоже не снимает', async () => {
    const { orderId } = await reserved();
    await addSucceededPayment(orderId);
    expect((await releaseUnusedPromoReservation(db, orderId)).applied).toBe(false);
  });

  it('releasePromoRedemption (решение человека) снимает даже spent', async () => {
    const { orderId } = await reserved();
    await claimPromoSpent(db, orderId);
    const { applied, redemption } = await releasePromoRedemption(db, { orderId });
    expect(applied).toBe(true);
    expect(redemption?.status).toBe('released');
    // Повтор идемпотентен.
    expect((await releasePromoRedemption(db, { orderId })).applied).toBe(false);
  });

  it('снятое занятие ВОСКРЕШАЕТСЯ повторной попыткой оплаты', async () => {
    // `payments/create` снимает занятие в catch; без воскрешения повторная
    // попытка оплатить тот же заказ навсегда теряла бы право на скидку.
    const { orderId, promoCodeId, userId } = await reserved();
    await releaseUnusedPromoReservation(db, orderId);

    const again = await reservePromoForOrder(db, {
      orderId,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      discountKopecks: 300_00,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    expect(again).toEqual({ ok: true });
    const row = await findPromoRedemptionByOrderId(db, orderId);
    expect(row).toMatchObject({ status: 'reserved', discountKopecks: 300_00, releasedBy: null });
    expect(row?.settledAt).toBeNull();
  });
});

describe('livePromoRedemptionSql — что считается израсходованной активацией', () => {
  async function reservedOn(status: string, opts: { paid?: boolean } = {}) {
    const userId = await createUser();
    const orderId = await createOrder(userId);
    const { id: promoCodeId } = await makeCode();
    await reservePromoForOrder(db, {
      orderId,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 1,
      maxRedemptions: null,
    });
    if (opts.paid) await addSucceededPayment(orderId);
    await setOrderStatus(orderId, status);
    return { userId, orderId, promoCodeId };
  }

  it('протухший заказ БЕЗ оплаты возвращает право автоматически', async () => {
    const { userId, promoCodeId } = await reservedOn('expired');
    expect(await countPromoRedemptions(db, { promoCodeId, userId })).toEqual({
      byUser: 0,
      total: 0,
    });
  });

  it('отменённый заказ БЕЗ оплаты возвращает право автоматически', async () => {
    const { userId, promoCodeId } = await reservedOn('cancelled');
    expect(await countPromoRedemptions(db, { promoCodeId, userId })).toEqual({
      byUser: 0,
      total: 0,
    });
  });

  it('⚠️ протухший заказ С УСПЕШНЫМ платежом право НЕ возвращает', async () => {
    // paid_after_terminal: деньги приняты, заказ захоронен кроном. Без этой
    // оговорки клиент получил бы и скидку по оплаченному счёту, и промокод.
    const { userId, promoCodeId } = await reservedOn('expired', { paid: true });
    expect(await countPromoRedemptions(db, { promoCodeId, userId })).toEqual({
      byUser: 1,
      total: 1,
    });
  });

  it('⚠️ failed НЕ возвращает право автоматически — это работа человека', async () => {
    // `failed` не синоним «деньги вернули»: туда же недоплата и отвергнутый
    // счёт. Автовозврат оттуда раздавал бы вторую скидку.
    const { userId, promoCodeId } = await reservedOn('failed');
    expect(await countPromoRedemptions(db, { promoCodeId, userId })).toEqual({
      byUser: 1,
      total: 1,
    });
  });

  it('возвращённое человеком право не считается израсходованным', async () => {
    const { userId, promoCodeId, orderId } = await reservedOn('failed');
    await releasePromoRedemption(db, { orderId });
    expect(await countPromoRedemptions(db, { promoCodeId, userId })).toEqual({
      byUser: 0,
      total: 0,
    });
  });

  it('вернувшееся право снова даёт клиенту применить код', async () => {
    const { userId, promoCodeId } = await reservedOn('expired');
    const next = await createOrder(userId);
    expect(
      await reservePromoForOrder(db, {
        orderId: next,
        promoCodeId,
        userId,
        ...RESERVE_ARGS,
        perUserLimit: 1,
        maxRedemptions: null,
      }),
    ).toEqual({ ok: true });
  });

  it('сводка кода считает по тому же правилу, что и лимиты', async () => {
    const { id: promoCodeId } = await makeCode({ maxRedemptions: 10 });
    const live = await createUser();
    const dead = await createUser();
    const liveOrder = await createOrder(live);
    const deadOrder = await createOrder(dead);
    const args = { promoCodeId, ...RESERVE_ARGS, perUserLimit: 1, maxRedemptions: 10 };
    await reservePromoForOrder(db, { ...args, orderId: liveOrder, userId: live });
    await reservePromoForOrder(db, { ...args, orderId: deadOrder, userId: dead });
    await setOrderStatus(deadOrder, 'expired');

    expect(await summarizePromoCode(db, promoCodeId)).toEqual({
      redemptions: 1,
      discountKopecks: 405_00,
    });
  });
});

describe('findPromoRedemptionsByOrderIds', () => {
  it('отдаёт применения пачкой', async () => {
    const userId = await createUser();
    const { id: promoCodeId } = await makeCode({ perUserLimit: 5 });
    const withPromo = await createOrder(userId);
    const without = await createOrder(userId);
    await reservePromoForOrder(db, {
      orderId: withPromo,
      promoCodeId,
      userId,
      ...RESERVE_ARGS,
      perUserLimit: 5,
      maxRedemptions: null,
    });

    const map = await findPromoRedemptionsByOrderIds(db, [withPromo, without]);
    expect(map.get(withPromo)?.discountKopecks).toBe(405_00);
    expect(map.get(without)).toBeUndefined();
  });

  it('пустой список не ходит в базу и отдаёт пустую карту', async () => {
    expect((await findPromoRedemptionsByOrderIds(db, [])).size).toBe(0);
  });
});
