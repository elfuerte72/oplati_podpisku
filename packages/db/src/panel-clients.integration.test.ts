import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import { upsertPaymentByProviderRef, claimPaymentSucceeded } from './repositories/payments.ts';
import { createConversation } from './repositories/conversations.ts';
import { appendMessage } from './repositories/messages.ts';
import { insertAnalyticsEvents } from './repositories/analytics.ts';
import { listClientFeedbackByUserForPanel, recordClientFeedback } from './repositories/funnel.ts';
import { upsertVpnSubscription } from './repositories/vpn-subscriptions.ts';
import {
  countClientSegmentsForPanel,
  getClientActivityForPanel,
  listClientsForPanel,
} from './repositories/panel-clients.ts';

/**
 * Раздел «Клиенты» панели: список с итогами, сегменты и лента действий.
 *
 * На реальном Postgres (PGlite + миграции), потому что проверяется именно SQL:
 * FILTER по общему списку «покупка состоялась», LATERAL-итоги, `GREATEST` с
 * NULL, признак «деньги приняты, заказ с ошибкой» через EXISTS по платежам и
 * чтение вьюхи `analytics_timeline`.
 */

let db: DB;
let seq = 0;

beforeAll(async () => {
  ({ db } = await createTestDb());
});

async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}): Promise<{
  id: string;
  telegramId: string | null;
}> {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `clients-tg-${++seq}`, ...over })
    .returning({ id: schema.users.id, telegramId: schema.users.telegramId });
  return rows[0]!;
}

async function makeOrder(
  userId: string,
  status:
    | 'draft'
    | 'ready_for_payment'
    | 'pending_payment'
    | 'completed'
    | 'failed'
    | 'expired'
    | 'refund_requested'
    | 'refunded',
  amountRub: number,
  paidAt: Date | null = null,
): Promise<{ id: string; shortId: string }> {
  const order = await createDraftOrder(db, {
    userId,
    status,
    customServiceDescription: `clients-test ${status}`,
    amountRub,
    originalAmount: Math.round(amountRub / 80),
    originalCurrency: 'USD',
  });
  if (paidAt) {
    await db.execute(sql`UPDATE orders SET paid_at = ${paidAt.toISOString()}::timestamptz WHERE id = ${order.id}`);
  }
  return order;
}

async function succeededPayment(orderId: string, amountRub: number): Promise<void> {
  const { payment } = await upsertPaymentByProviderRef(db, {
    orderId,
    provider: 'freekassa',
    providerRef: `clients-inv-${++seq}`,
    amountRub,
  });
  await claimPaymentSucceeded(db, { paymentId: payment.id });
}

describe('listClientsForPanel', () => {
  // Одинаковый префикс имени отделяет клиентов этого блока от чужих фикстур
  // в общей базе теста.
  const NAME = 'Клиентский тест';
  let buyer: string;
  let tried: string;
  let lurker: string;
  let webOnly: string;
  let stuck: string;

  beforeAll(async () => {
    buyer = (await makeUser({ displayName: `${NAME} покупатель`, email: 'buyer@example.com' })).id;
    tried = (await makeUser({ displayName: `${NAME} пробовал` })).id;
    lurker = (await makeUser({ displayName: `${NAME} только зашёл`, phone: '+79991230000' })).id;
    webOnly = (
      await makeUser({ telegramId: null, webSessionId: `clients-web-${++seq}`, displayName: `${NAME} сайт` })
    ).id;
    stuck = (await makeUser({ displayName: `${NAME} застрял` })).id;

    // Покупатель: две состоявшиеся покупки и один протухший черновик — в
    // «Оплачено» попадают только первые две, в «Заказов» все три.
    await makeOrder(buyer, 'completed', 100_000, new Date('2026-08-01T10:00:00Z'));
    await makeOrder(buyer, 'completed', 250_000, new Date('2026-08-20T10:00:00Z'));
    await makeOrder(buyer, 'expired', 999_900);

    // Пробовал: оформил и не заплатил.
    await makeOrder(tried, 'expired', 50_000);
    await makeOrder(tried, 'ready_for_payment', 60_000);

    // Застрял: деньги приняты (платёж succeeded), заказ в «Ошибке».
    const failed = await makeOrder(stuck, 'failed', 80_000);
    await succeededPayment(failed.id, 80_000);
  });

  function byName<T extends { displayName: string | null }>(items: T[], suffix: string): T | undefined {
    return items.find((i) => i.displayName === `${NAME} ${suffix}`);
  }

  it('строка несёт итоги, посчитанные в базе по общему списку «покупка состоялась»', async () => {
    const { items } = await listClientsForPanel(db, { query: NAME });
    const row = byName(items, 'покупатель');

    expect(row).toBeDefined();
    expect(row?.ordersCount).toBe(3);
    expect(row?.purchasedCount).toBe(2);
    expect(row?.purchasedRubKopecks).toBe(350_000);
    expect(row?.lastPaidAt?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
    expect(row?.hasEmail).toBe(true);
    expect(row?.hasPhone).toBe(false);
    expect(row?.moneyStuck).toBe(false);
  });

  it('исход строки считается тем же предикатом, что сегменты', async () => {
    // Пилюля в строке и счётчик над ней обязаны говорить одно: `kind` рождается
    // в SQL из тех же условий, что и сегменты, а не второй формулой в JS.
    const { items } = await listClientsForPanel(db, { query: NAME });

    expect(byName(items, 'покупатель')?.kind).toBe('buyer');
    expect(byName(items, 'пробовал')?.kind).toBe('tried');
    expect(byName(items, 'застрял')?.kind).toBe('tried');
    expect(byName(items, 'только зашёл')?.kind).toBe('lurker');
    expect(byName(items, 'сайт')?.kind).toBe('lurker');
  });

  it('сегменты режут базу по факту покупки, заказа и связи', async () => {
    const seg = async (segment: 'buyers' | 'tried' | 'lurkers' | 'unreachable' | 'stuck') =>
      (await listClientsForPanel(db, { query: NAME, segment })).items.map((i) => i.id);

    expect(await seg('buyers')).toEqual([buyer]);
    // Три сегмента по исходу заказов делят базу без остатка: покупка
    // состоялась / оформлял, но покупки нет / не оформлял. Застрявший —
    // «пробовал»: покупка у него НЕ состоялась, хотя деньги приняты.
    expect(new Set(await seg('tried'))).toEqual(new Set([tried, stuck]));
    // «Только зашли» — без единого заказа, канал не важен.
    expect(new Set(await seg('lurkers'))).toEqual(new Set([lurker, webOnly]));
    // Два сквозных признака поверх исхода: связи нет и деньги без выдачи.
    expect(await seg('unreachable')).toEqual([webOnly]);
    expect(await seg('stuck')).toEqual([stuck]);
    expect(await seg('buyers')).not.toContain(stuck);
  });

  it('«оплата без выдачи» держится, пока деньги у нас: возврат запрошен — да, возвращён — нет', async () => {
    // `failed → refund_requested` — разрешённый переход, деньги остаются до
    // `refunded`; признак не должен гаснуть на первом же шаге возврата.
    const requested = await makeUser({ displayName: 'Возврат запрошен' });
    const requestedOrder = await makeOrder(requested.id, 'refund_requested', 40_000);
    await succeededPayment(requestedOrder.id, 40_000);

    const refunded = await makeUser({ displayName: 'Возврат сделан' });
    const refundedOrder = await makeOrder(refunded.id, 'refunded', 40_000);
    await succeededPayment(refundedOrder.id, 40_000);

    const rows = (await listClientsForPanel(db, { segment: 'stuck' })).items.map((i) => i.id);

    expect(rows).toContain(requested.id);
    expect(rows).not.toContain(refunded.id);
  });

  it('счётчики сегментов считаются при том же поиске, что и список', async () => {
    const counts = await countClientSegmentsForPanel(db, { query: NAME });

    expect(counts).toEqual({ all: 5, buyers: 1, tried: 2, lurkers: 2, unreachable: 1, stuck: 1 });
    // Исход заказов делит базу без остатка — это свойство, на которое
    // опирается экран, показывая счётчики рядом.
    expect(counts.buyers + counts.tried + counts.lurkers).toBe(counts.all);
  });

  it('счётчики уважают и период регистрации — те же условия, что у списка', async () => {
    const stamp = '2020-01-01T00:00:00.000Z';
    const old = await makeUser({ displayName: 'Давний клиент' });
    await db.execute(sql`UPDATE users SET created_at = ${stamp}::timestamptz WHERE id = ${old.id}`);

    const before = await countClientSegmentsForPanel(db, { query: 'Давний', createdTo: stamp });
    const from = await countClientSegmentsForPanel(db, { query: 'Давний', createdFrom: stamp });

    expect(before.all).toBe(0);
    expect(from.all).toBe(1);
    expect(from.lurkers).toBe(1);
  });

  it('ищет по имени, telegram, @username, почте и цифрам телефона', async () => {
    const ids = async (query: string) => (await listClientsForPanel(db, { query })).items.map((i) => i.id);

    expect(await ids('buyer@example')).toEqual([buyer]);
    expect(await ids('999 123 00 00')).toEqual([lurker]);
    // Три цифры — перебор половины базы, а не поиск.
    expect(await ids('999')).not.toContain(lurker);

    // Другой префикс имени: клиенты этого блока считаются под `NAME`, и лишняя
    // строка сдвигала бы счётчики соседних тестов.
    const withUsername = await makeUser({ displayName: 'Ник для поиска', telegramUsername: 'clients_nick' });
    expect(await ids('clients_nick')).toEqual([withUsername.id]);
    expect(await ids(withUsername.telegramId ?? '')).toEqual([withUsername.id]);
  });

  it('процент и подчёркивание ищутся как символы, а не как шаблон LIKE', async () => {
    expect((await listClientsForPanel(db, { query: '%%%' })).items).toEqual([]);
  });

  it('сортировки: «оплачено: больше» и «заказов: больше» ставят нужного первым, «по активности» — свежий след', async () => {
    const byMoney = await listClientsForPanel(db, { query: NAME, sort: 'purchased_desc' });
    expect(byMoney.items[0]?.id).toBe(buyer);

    const byOrders = await listClientsForPanel(db, { query: NAME, sort: 'orders_desc' });
    expect(byOrders.items[0]?.id).toBe(buyer);
    expect(byOrders.items.map((i) => i.ordersCount)).toEqual([...byOrders.items.map((i) => i.ordersCount)].sort((a, b) => b - a));

    // Сообщение боту — тоже след: клиент без заказов, но написавший только
    // что, идёт первым.
    const conversation = await createConversation(db, { userId: lurker, channel: 'telegram' });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'привет' });
    const byActivity = await listClientsForPanel(db, { query: NAME, sort: 'active' });
    expect(byActivity.items[0]?.id).toBe(lurker);
    expect(byActivity.items[0]?.lastActivityAt).not.toBeNull();
    // У клиента без единого следа — прочерк, а не эпоха Unix.
    expect(byName(byActivity.items, 'сайт')?.lastActivityAt).toBeNull();

    // Карточка считает след ТЕМ ЖЕ выражением: под одним ярлыком список и
    // карточка обязаны показывать одно время.
    const card = await getClientActivityForPanel(db, lurker);
    expect(card.lastActivityAt?.toISOString()).toBe(byActivity.items[0]?.lastActivityAt?.toISOString());
  });

  it('листается смещением с признаком «есть ещё» по строке сверх потолка', async () => {
    const first = await listClientsForPanel(db, { query: NAME, limit: 2, offset: 0 });
    const second = await listClientsForPanel(db, { query: NAME, limit: 2, offset: 2 });
    const tail = await listClientsForPanel(db, { query: NAME, limit: 2, offset: 4 });

    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(true);
    expect(tail.hasMore).toBe(false);
    // Страницы не пересекаются: порядок полный (тай-брейкер по id).
    const seen = [...first.items, ...second.items, ...tail.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('окно регистрации полуоткрытое: левая граница внутри, правая — снаружи', async () => {
    const stamp = new Date('2026-05-05T12:00:00Z');
    // Свой префикс — см. тест поиска: `NAME` считают соседние тесты.
    const user = await makeUser({ displayName: 'Датированный клиент' });
    await db.execute(sql`UPDATE users SET created_at = ${stamp.toISOString()}::timestamptz WHERE id = ${user.id}`);

    const inside = await listClientsForPanel(db, { query: 'Датированный', createdFrom: stamp.toISOString() });
    const outside = await listClientsForPanel(db, { query: 'Датированный', createdTo: stamp.toISOString() });

    expect(inside.items.map((i) => i.id)).toContain(user.id);
    expect(outside.items.map((i) => i.id)).not.toContain(user.id);
  });

  it('веб-сессия наружу не отдаётся — только факт её наличия', async () => {
    const { items } = await listClientsForPanel(db, { query: `${NAME} сайт` });
    const row = items[0];

    expect(row?.hasWebSession).toBe(true);
    expect(Object.keys(row ?? {})).not.toContain('webSessionId');
  });
});

describe('getClientActivityForPanel', () => {
  it('лента собирает телеметрию и денежные вехи одного клиента, новые сверху', async () => {
    const user = await makeUser({ displayName: 'Клиент с лентой' });
    const order = await makeOrder(user.id, 'ready_for_payment', 70_000);
    await insertAnalyticsEvents(db, [
      {
        eventKey: `clients-ev-${++seq}`,
        name: 'catalog_open',
        channel: 'miniapp',
        origin: 'client',
        telegramId: user.telegramId,
        occurredAt: new Date('2026-09-01T10:00:00Z'),
      },
      {
        eventKey: `clients-ev-${++seq}`,
        name: 'service_click',
        channel: 'miniapp',
        origin: 'client',
        telegramId: user.telegramId,
        props: { slug: 'spotify' },
        occurredAt: new Date('2026-09-01T10:01:00Z'),
      },
    ]);

    const activity = await getClientActivityForPanel(db, user.id);
    const names = activity.events.map((e) => e.name);

    // `order_created` из журнала заказа приходит вехой `order_proposed` — та же
    // вьюха, что у воронки раздела «Отчёты».
    expect(names).toContain('order_proposed');
    expect(names).toContain('catalog_open');
    expect(names).toContain('service_click');
    expect(activity.events.find((e) => e.name === 'order_proposed')?.orderShortId).toBe(order.shortId);
    expect(activity.events.find((e) => e.name === 'service_click')?.props).toEqual({ slug: 'spotify' });
    // Новые сверху: заказ создан «сейчас», телеметрия датирована прошлым.
    expect(names[0]).toBe('order_proposed');
    expect(activity.hasMoreEvents).toBe(false);
  });

  it('чужие события в ленту не попадают', async () => {
    const a = await makeUser({ displayName: 'Клиент А ленты' });
    const b = await makeUser({ displayName: 'Клиент Б ленты' });
    await insertAnalyticsEvents(db, [
      {
        eventKey: `clients-ev-${++seq}`,
        name: 'bot_start',
        channel: 'bot',
        origin: 'server',
        telegramId: b.telegramId,
        occurredAt: new Date(),
      },
    ]);

    const activity = await getClientActivityForPanel(db, a.id);

    expect(activity.events).toEqual([]);
  });

  it('усечение проговаривается признаком «есть ещё»', async () => {
    const user = await makeUser({ displayName: 'Клиент с длинной лентой' });
    await insertAnalyticsEvents(
      db,
      Array.from({ length: 4 }, (_, i) => ({
        eventKey: `clients-ev-${++seq}`,
        name: 'page_view',
        channel: 'web',
        origin: 'client' as const,
        telegramId: user.telegramId,
        occurredAt: new Date(Date.UTC(2026, 8, 1, 10, i)),
      })),
    );

    const activity = await getClientActivityForPanel(db, user.id, { limit: 3 });

    expect(activity.events).toHaveLength(3);
    expect(activity.hasMoreEvents).toBe(true);
  });

  it('поддержка: считает сообщения САМОГО клиента и отдаёт режим последнего разговора', async () => {
    const user = await makeUser({ displayName: 'Клиент поддержки' });
    const conversation = await createConversation(db, { userId: user.id, channel: 'telegram' });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'помогите' });
    await appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: 'ответ бота' });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'спасибо' });
    await db.execute(
      sql`UPDATE conversations SET handoff_mode = 'operator' WHERE id = ${conversation.id}`,
    );

    const { support } = await getClientActivityForPanel(db, user.id);

    expect(support.conversationsCount).toBe(1);
    expect(support.clientMessagesCount).toBe(2);
    expect(support.lastClientMessageAt).not.toBeNull();
    expect(support.lastMode).toBe('operator');
  });

  it('VPN: статус и срок без ссылки-подписки', async () => {
    const user = await makeUser({ displayName: 'Клиент с VPN' });
    await upsertVpnSubscription(db, {
      userId: user.id,
      telegramId: user.telegramId ?? '',
      remnawaveUuid: '11111111-2222-4333-8444-555555555555',
      shortUuid: `short-${seq}`,
      subscriptionUrl: 'https://panel.example/sub/secret',
      status: 'ACTIVE',
      expireAt: new Date('2027-01-01T00:00:00Z'),
    });

    const { vpn } = await getClientActivityForPanel(db, user.id);

    expect(vpn?.status).toBe('ACTIVE');
    expect(vpn?.expireAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(Object.keys(vpn ?? {})).not.toContain('subscriptionUrl');
  });

  it('у клиента без следов — пустая лента, нули и без VPN', async () => {
    const user = await makeUser({ displayName: 'Клиент без следов' });

    const activity = await getClientActivityForPanel(db, user.id);

    expect(activity.events).toEqual([]);
    expect(activity.support).toEqual({
      conversationsCount: 0,
      clientMessagesCount: 0,
      lastClientMessageAt: null,
      lastMode: null,
    });
    expect(activity.vpn).toBeNull();
  });
});

describe('listClientFeedbackByUserForPanel', () => {
  it('ответы клиента с заказом-триггером, новые сверху', async () => {
    const user = await makeUser({ displayName: 'Клиент с отзывами' });
    const order = await makeOrder(user.id, 'completed', 90_000, new Date());
    await recordClientFeedback(db, { userId: user.id, kind: 'start_survey', answer: 'thinking' });
    // Время первого ответа ставится явно: у PGlite `now()` — миллисекунды, и
    // два подряд INSERT получают одинаковый `created_at`, а тай-брейкер по
    // случайному uuid делал тест красным через раз.
    await db.execute(sql`
      UPDATE client_feedback SET created_at = ${'2026-09-01T10:00:00.000Z'}::timestamptz
      WHERE user_id = ${user.id} AND kind = 'start_survey'
    `);
    await recordClientFeedback(db, { userId: user.id, kind: 'order_rating', orderId: order.id, score: 5 });

    const rows = await listClientFeedbackByUserForPanel(db, user.id);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('order_rating');
    expect(rows[0]?.score).toBe(5);
    expect(rows[0]?.order?.shortId).toBe(order.shortId);
    expect(rows[1]?.kind).toBe('start_survey');
    expect(rows[1]?.answer).toBe('thinking');
    expect(rows[1]?.order).toBeNull();
  });
});
