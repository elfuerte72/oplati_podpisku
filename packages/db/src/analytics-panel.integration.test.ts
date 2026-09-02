import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { ANALYTICS_FUNNEL } from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { createDraftOrder } from './repositories/orders.ts';
import {
  activeSubjectsByDay,
  catalogClicksByService,
  dayKeysInRange,
  funnelByPeriod,
  revenueByDay,
  revenueSummary,
  stepConversions,
  topServicesByPaidOrders,
  type AnalyticsRange,
} from './repositories/analytics-panel.ts';

/**
 * Выборки раздела «Аналитика» панели (спека `.scratch/admin-panel-v2/`,
 * тикет 02) — РЕАЛЬНЫЙ Postgres (PGlite) с РЕАЛЬНЫМИ миграциями: воронка и
 * клики читаются из вьюхи `analytics_timeline` (0029), и подменой её не
 * проверить.
 *
 * Все фикстуры привязаны к ОДНОМУ окну `RANGE` (три UTC-дня), чтобы граничные
 * случаи — платёж за секунду до начала, за секунду до конца — были явными.
 */

let db: DB;

/** Окно [01.03 00:00, 04.03 00:00) UTC — три календарных дня. */
const RANGE: AnalyticsRange = {
  since: '2026-03-01T00:00:00.000Z',
  until: '2026-03-04T00:00:00.000Z',
};
/** Пустое окно далеко в прошлом: событий там нет по построению. */
const EMPTY_RANGE: AnalyticsRange = {
  since: '2020-01-01T00:00:00.000Z',
  until: '2020-01-04T00:00:00.000Z',
};

let seq = 0;
async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-ap-${++seq}`, ...over })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('users insert');
  return row;
}

async function makeService(slug: string, name: string) {
  const rows = await db
    .insert(schema.services)
    .values({ slug, name, category: 'test' })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('services insert');
  return row;
}

/**
 * Оплаченный заказ: строка заказа в покупном статусе + успешный платёж с
 * заданным временем успеха. Время ставится прямыми UPDATE/INSERT (аранжировка):
 * `claimPaymentSucceeded` пишет `now()`, а тестам нужны даты на границах окна.
 */
async function makePaidOrder(input: {
  userId: string;
  serviceId?: string | null;
  amountKopecks: number;
  paidAt: Date;
  status?: 'paid' | 'completed' | 'failed';
}) {
  const order = await createDraftOrder(db, {
    userId: input.userId,
    status: 'draft',
    serviceId: input.serviceId ?? null,
    customServiceDescription: input.serviceId ? null : 'своя подписка',
    amountRub: input.amountKopecks,
    originalAmount: 1000,
    originalCurrency: 'USD',
  });
  const status = input.status ?? 'completed';
  await db.execute(
    sql`UPDATE orders SET status = ${status}::order_status, paid_at = ${input.paidAt.toISOString()}::timestamptz WHERE id = ${order.id}`,
  );
  await db.insert(schema.payments).values({
    orderId: order.id,
    provider: 'freekassa',
    providerRef: `ap-ref-${++seq}`,
    amountRub: input.amountKopecks,
    status: 'succeeded',
    completedAt: input.paidAt,
  });
  return order;
}

async function trackEvent(input: {
  name: string;
  occurredAt: Date;
  webSessionId?: string;
  telegramId?: string;
  props?: Record<string, string | number | boolean>;
}) {
  await db.insert(schema.analyticsEvents).values({
    eventKey: `ap-ev-${++seq}`,
    name: input.name,
    channel: 'web',
    origin: 'client',
    webSessionId: input.webSessionId ?? null,
    telegramId: input.telegramId ?? null,
    props: input.props ?? null,
    occurredAt: input.occurredAt,
  });
}

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('dayKeysInRange', () => {
  it('перечисляет календарные UTC-дни окна, правая граница исключена', () => {
    expect(dayKeysInRange(RANGE)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('окно короче суток даёт один день, перевёрнутое — ни одного', () => {
    expect(
      dayKeysInRange({ since: '2026-03-01T00:00:00.000Z', until: '2026-03-01T12:00:00.000Z' }),
    ).toEqual(['2026-03-01']);
    expect(
      dayKeysInRange({ since: '2026-03-04T00:00:00.000Z', until: '2026-03-01T00:00:00.000Z' }),
    ).toEqual([]);
  });
});

describe('деньги: выручка по дням и сводка', () => {
  let userId: string;
  let spotifyId: string;

  beforeAll(async () => {
    userId = (await makeUser()).id;
    spotifyId = (await makeService('ap-spotify', 'Spotify')).id;

    // Границы окна: последняя секунда первого дня и последняя секунда
    // последнего дня — обе ВНУТРИ; секунда до начала и ровно конец — снаружи.
    await makePaidOrder({ userId, serviceId: spotifyId, amountKopecks: 100_00, paidAt: at('2026-03-01T23:59:59Z') });
    await makePaidOrder({ userId, serviceId: spotifyId, amountKopecks: 250_00, paidAt: at('2026-03-03T23:59:59Z') });
    await makePaidOrder({ userId, serviceId: spotifyId, amountKopecks: 999_00, paidAt: at('2026-02-28T23:59:59Z') });
    await makePaidOrder({ userId, serviceId: spotifyId, amountKopecks: 777_00, paidAt: at('2026-03-04T00:00:00Z') });
    // Оплаченный, но провалившийся заказ: деньги получены (платёж succeeded),
    // а покупка не состоялась — в выручке есть, в оплаченных заказах нет.
    await makePaidOrder({
      userId,
      serviceId: spotifyId,
      amountKopecks: 50_00,
      paidAt: at('2026-03-02T12:00:00Z'),
      status: 'failed',
    });
  });

  it('ряд по дням всегда полный: дни без платежей заполнены нулями', async () => {
    const rows = await revenueByDay(db, RANGE);

    expect(rows.map((r) => r.day)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(rows[0]).toEqual({ day: '2026-03-01', amountKopecks: 100_00, paidOrders: 1 });
    // День с провалившимся заказом: деньги пришли, покупки нет.
    expect(rows[1]).toEqual({ day: '2026-03-02', amountKopecks: 50_00, paidOrders: 0 });
    expect(rows[2]).toEqual({ day: '2026-03-03', amountKopecks: 250_00, paidOrders: 1 });
  });

  it('сводка считает деньги в копейках и средний чек целым', async () => {
    const summary = await revenueSummary(db, RANGE);

    expect(summary).toEqual({
      // Выручка — все успешные платежи, включая провалившийся заказ на 50 ₽.
      amountKopecks: 400_00,
      paidOrders: 2,
      // Средний чек — из ОДНОГО множества состоявшихся покупок: (100 + 250) / 2.
      averageKopecks: 175_00,
    });
  });

  it('пустой период — нули, средний чек 0 (не деление на ноль)', async () => {
    expect(await revenueSummary(db, EMPTY_RANGE)).toEqual({
      amountKopecks: 0,
      paidOrders: 0,
      averageKopecks: 0,
    });
    const rows = await revenueByDay(db, EMPTY_RANGE);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.amountKopecks === 0 && r.paidOrders === 0)).toBe(true);
  });
});

describe('воронка за период', () => {
  beforeAll(async () => {
    // Два анонима дошли до каталога, один выбрал сервис; событие за окном не
    // считается. Денежные вехи (шаги 4–7) здесь не сеем: они читаются из
    // order_events через ту же вьюху, и их нули — часть проверки «семь строк».
    await trackEvent({ name: 'page_view', occurredAt: at('2026-03-01T10:00:00Z'), webSessionId: 'ap-s1' });
    await trackEvent({ name: 'page_view', occurredAt: at('2026-03-02T10:00:00Z'), webSessionId: 'ap-s1' });
    await trackEvent({ name: 'page_view', occurredAt: at('2026-03-02T11:00:00Z'), webSessionId: 'ap-s2' });
    await trackEvent({ name: 'catalog_open', occurredAt: at('2026-03-02T10:01:00Z'), webSessionId: 'ap-s1' });
    await trackEvent({ name: 'catalog_open', occurredAt: at('2026-03-02T11:01:00Z'), webSessionId: 'ap-s2' });
    await trackEvent({
      name: 'service_click',
      occurredAt: at('2026-03-02T10:02:00Z'),
      webSessionId: 'ap-s1',
      props: { slug: 'ap-spotify' },
    });
    await trackEvent({ name: 'page_view', occurredAt: at('2026-02-20T10:00:00Z'), webSessionId: 'ap-s3' });
  });

  it('семь шагов всегда, субъекты считаются distinct по subject_key', async () => {
    const rows = await funnelByPeriod(db, RANGE);

    expect(rows.map((r) => r.step)).toEqual(ANALYTICS_FUNNEL.map((s) => s.step));
    expect(rows.map((r) => r.name)).toEqual(ANALYTICS_FUNNEL.map((s) => s.name));
    expect(rows.every((r) => r.title.length > 0)).toBe(true);
    // Два повторных page_view одной сессии — один субъект; сессия за окном не в счёт.
    expect(rows[0]?.subjects).toBe(2);
    expect(rows[1]?.subjects).toBe(2);
    expect(rows[2]?.subjects).toBe(1);
  });

  it('пустой период — семь строк с нулями', async () => {
    const rows = await funnelByPeriod(db, EMPTY_RANGE);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.subjects === 0)).toBe(true);
  });

  it('stepConversions: у первого шага и при нулевом предыдущем — null, не деление на ноль', () => {
    const rows = stepConversions([
      { step: 1, name: 'a', title: 'A', subjects: 10 },
      { step: 2, name: 'b', title: 'B', subjects: 5 },
      { step: 3, name: 'c', title: 'C', subjects: 0 },
      { step: 4, name: 'd', title: 'D', subjects: 2 },
    ]);
    expect(rows.map((r) => r.conversion)).toEqual([null, 0.5, 0, null]);
  });
});

describe('продукт: топ сервисов, клики каталога, активность', () => {
  let userId: string;

  beforeAll(async () => {
    userId = (await makeUser()).id;
    const netflix = await makeService('ap-netflix', 'Netflix');
    const chatgpt = await makeService('ap-chatgpt', 'ChatGPT');
    // Netflix — два заказа, ChatGPT — один, и один заказ вне каталога.
    await makePaidOrder({ userId, serviceId: netflix.id, amountKopecks: 10_00, paidAt: at('2026-03-01T12:00:00Z') });
    await makePaidOrder({ userId, serviceId: netflix.id, amountKopecks: 20_00, paidAt: at('2026-03-02T12:00:00Z') });
    await makePaidOrder({ userId, serviceId: chatgpt.id, amountKopecks: 30_00, paidAt: at('2026-03-02T13:00:00Z') });
    await makePaidOrder({ userId, serviceId: null, amountKopecks: 40_00, paidAt: at('2026-03-03T12:00:00Z') });

    await trackEvent({ name: 'service_click', occurredAt: at('2026-03-01T09:00:00Z'), webSessionId: 'ap-c1', props: { slug: 'ap-netflix' } });
    await trackEvent({ name: 'service_click', occurredAt: at('2026-03-01T09:05:00Z'), webSessionId: 'ap-c1', props: { slug: 'ap-netflix' } });
    await trackEvent({ name: 'service_click', occurredAt: at('2026-03-03T09:00:00Z'), webSessionId: 'ap-c2', props: { slug: 'ap-chatgpt' } });
    // Слаг, которого в каталоге нет (архивный сервис): строка остаётся, имя пустое.
    await trackEvent({ name: 'service_click', occurredAt: at('2026-03-03T09:10:00Z'), webSessionId: 'ap-c2', props: { slug: 'ap-gone' } });
  });

  it('топ сервисов по оплаченным заказам, кастомные — одной строкой «вне каталога»', async () => {
    const rows = await topServicesByPaidOrders(db, RANGE);

    const netflix = rows.find((r) => r.serviceSlug === 'ap-netflix');
    expect(netflix).toEqual({ serviceSlug: 'ap-netflix', title: 'Netflix', orders: 2, amountKopecks: 30_00 });
    const custom = rows.find((r) => r.serviceSlug === null);
    expect(custom).toMatchObject({ title: null, orders: 1, amountKopecks: 40_00 });
    // Сортировка — по числу заказов, свежие Spotify-заказы из первого describe тоже здесь.
    expect(rows[0]?.orders).toBeGreaterThanOrEqual(rows[rows.length - 1]?.orders ?? 0);
  });

  it('топ режется limit', async () => {
    const rows = await topServicesByPaidOrders(db, RANGE, 1);
    expect(rows).toHaveLength(1);
  });

  it('клики каталога группируются по slug, имя — из каталога, у архивного slug имени нет', async () => {
    const rows = await catalogClicksByService(db, RANGE);

    expect(rows[0]).toEqual({ serviceSlug: 'ap-netflix', title: 'Netflix', clicks: 2, subjects: 1 });
    expect(rows.find((r) => r.serviceSlug === 'ap-gone')).toEqual({
      serviceSlug: 'ap-gone',
      title: null,
      clicks: 1,
      subjects: 1,
    });
    expect(await catalogClicksByService(db, RANGE, 1)).toHaveLength(1);
  });

  it('активность по дням — distinct субъекты, дни без событий заполнены нулями', async () => {
    const rows = await activeSubjectsByDay(db, RANGE);

    expect(rows.map((r) => r.day)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    // Телеметрия из describe'ов выше: 01.03 — сессии ap-s1 и ap-c1, 02.03 —
    // ap-s1 и ap-s2, 03.03 — ap-c2. Денежные вехи заказов сюда не попадают:
    // `order_created` у фикстур датирован временем прогона, а не окном.
    expect(rows.map((r) => r.subjects)).toEqual([2, 2, 1]);
    const empty = await activeSubjectsByDay(db, EMPTY_RANGE);
    expect(empty.every((r) => r.subjects === 0)).toBe(true);
  });
});
