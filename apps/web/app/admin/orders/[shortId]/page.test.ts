import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PanelOrderDetail } from '@oplati/db';

/**
 * Блок «Цена» карточки заказа (аудит CRM 2026-09-17, тикет 05). Счёт = полная
 * цена − промокод − баллы; карточка знала только про баллы и считала «Запрошено
 * у шлюза» вычитанием на экране — оператор принимал скидку по промокоду за
 * недоплату. Выборка проверена на PGlite (`panel-discounts.integration.test.ts`),
 * здесь — «строки репозитория → разметка».
 */

const h = vi.hoisted(() => ({
  access: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@/lib/panel/guard', () => ({ panelPageAccess: h.access }));

vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({}) as unknown,
    getOrderDetailForPanel: h.detail,
  };
});

vi.mock('@/components/panel/PanelShell', () => ({
  PanelShell: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-shell': '' }, children),
  PanelForbidden: ({ title }: { title: string }) =>
    createElement('div', { 'data-forbidden': title }),
}));

// Кнопки операций — клиентские компоненты с роутером приложения; блок цены от
// них не зависит.
vi.mock('@/components/panel/BonusRefund', () => ({ BonusRefund: () => null }));
vi.mock('@/components/panel/ManualFulfillment', () => ({ ManualFulfillment: () => null }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

import PanelOrderPage from './page';

const admin = {
  id: 'staff-1',
  email: 'owner@example.com',
  displayName: 'Владелец',
  role: 'admin' as const,
  telegramId: '1',
  lastLoginAt: null,
};

const at = new Date('2026-09-20T10:00:00.000Z');

function payment(amountRubKopecks: number, status: 'pending' | 'succeeded' | 'failed') {
  return {
    id: `p-${amountRubKopecks}-${status}`,
    provider: 'freekassa',
    providerRef: 'ref',
    providerInvoiceNumber: null,
    amountRubKopecks,
    status,
    lastProviderStatus: null,
    lastProviderStatusAt: null,
    createdAt: at,
    completedAt: status === 'succeeded' ? at : null,
    expiresAt: null,
  };
}

function detail(over: Partial<PanelOrderDetail> = {}): PanelOrderDetail {
  return {
    hasSucceededPayment: true,
    order: {
      id: 'order-1',
      shortId: 'ORD-AAAAA',
      status: 'completed',
      amountRubKopecks: 3000_00,
      cardIssueFeeKopecks: 0,
      commissionPercent: 30,
      originalAmount: 2000,
      originalCurrency: 'USD',
      usdtRubRateKopecks: 81_0000,
      createdAt: at,
      expiresAt: null,
      paidAt: at,
      fulfilledAt: at,
    },
    client: { id: 'user-1', displayName: 'Иван', telegramId: '42', email: null },
    serviceName: 'ChatGPT',
    assignedOperatorName: null,
    events: [],
    payments: [],
    card: null,
    bonus: null,
    promo: null,
    ...over,
  };
}

const bonus = (over: Partial<NonNullable<PanelOrderDetail['bonus']>> = {}) => ({
  amountUsdCents: 370,
  discountKopecks: 300_00,
  status: 'spent' as const,
  live: true,
  reservedAt: at,
  settledAt: at,
  releasedByName: null,
  ...over,
});

const promo = (over: Partial<NonNullable<PanelOrderDetail['promo']>> = {}) => ({
  code: 'ДАРЛИНГ',
  discountKopecks: 405_00,
  status: 'spent' as const,
  live: true,
  ...over,
});

/** Разделитель тысяч у `toLocaleString('ru-RU')` — неразрывный пробел. */
const plain = (html: string) => html.replace(/[  ]/g, ' ');

async function render(): Promise<string> {
  const element = await PanelOrderPage({ params: Promise.resolve({ shortId: 'ORD-AAAAA' }) });
  return plain(renderToStaticMarkup(element));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ allowed: true, actor: admin });
});

describe('/admin/orders/<shortId> — скидки в блоке «Цена»', () => {
  it('промокод и баллы: четыре строки по порядку, последняя совпадает с платежом', async () => {
    h.detail.mockResolvedValue(
      detail({
        promo: promo(),
        bonus: bonus(),
        payments: [payment(2295_00, 'succeeded')],
      }),
    );

    const html = await render();

    const total = html.indexOf('Итого');
    const promoAt = html.indexOf('Промокод ДАРЛИНГ');
    const redeemed = html.indexOf('Погашено баллами');
    const invoiced = html.indexOf('Запрошено у шлюза');
    expect(total).toBeGreaterThan(-1);
    expect(promoAt).toBeGreaterThan(total);
    expect(redeemed).toBeGreaterThan(promoAt);
    expect(invoiced).toBeGreaterThan(redeemed);
    expect(html).toContain('−405 ₽');
    expect(html).toContain('−300 ₽');
    expect(html).toContain('<strong>2 295 ₽</strong>');
  });

  it('только промокод: «Итого 3 000», «Промокод −405», «Запрошено у шлюза 2 595»', async () => {
    h.detail.mockResolvedValue(
      detail({
        order: { ...detail().order, status: 'pending_payment', paidAt: null, fulfilledAt: null },
        hasSucceededPayment: false,
        promo: promo(),
        payments: [payment(2595_00, 'pending')],
      }),
    );

    const html = await render();

    expect(html).toContain('3 000 ₽');
    expect(html).toContain('Промокод ДАРЛИНГ');
    expect(html).toContain('<strong>2 595 ₽</strong>');
    expect(html).not.toContain('Погашено баллами');
  });

  it('без скидок — как раньше: ни строки промокода, ни «Запрошено у шлюза»', async () => {
    h.detail.mockResolvedValue(detail({ payments: [payment(3000_00, 'succeeded')] }));

    const html = await render();

    expect(html).not.toContain('Промокод');
    expect(html).not.toContain('Погашено баллами');
    expect(html).not.toContain('Запрошено у шлюза');
  });

  it('протухший заказ без платежа: резерв баллов вернулся правилом — строки нет', async () => {
    h.detail.mockResolvedValue(
      detail({
        order: { ...detail().order, status: 'expired', paidAt: null, fulfilledAt: null },
        hasSucceededPayment: false,
        bonus: bonus({ status: 'reserved', live: false, settledAt: null }),
      }),
    );

    const html = await render();

    expect(html).not.toContain('Погашено баллами');
    expect(html).not.toContain('Запрошено у шлюза');
  });

  it('скидка есть, а счёта ещё нет — строки «Запрошено у шлюза» нет', async () => {
    h.detail.mockResolvedValue(
      detail({
        order: { ...detail().order, status: 'ready_for_payment', paidAt: null, fulfilledAt: null },
        hasSucceededPayment: false,
        promo: promo(),
      }),
    );

    const html = await render();

    expect(html).toContain('Промокод ДАРЛИНГ');
    expect(html).not.toContain('Запрошено у шлюза');
  });

  it('промокод вернули ПОСЛЕ оплаты со скидкой: строка «возвращён» и счёт 2 595', async () => {
    // Ревью 2026-09-25, ось A: без строки карточка показывала «Итого 3 000»
    // при платеже 2 595 — ту самую «недоплату», которую чинит тикет 05.
    h.detail.mockResolvedValue(
      detail({
        order: { ...detail().order, status: 'failed', fulfilledAt: null },
        promo: promo({ status: 'released', live: false }),
        payments: [payment(2595_00, 'succeeded')],
      }),
    );

    const html = await render();

    expect(html).toContain('Промокод ДАРЛИНГ');
    expect(html).toContain('промокод возвращён клиенту');
    expect(html).toContain('<strong>2 595 ₽</strong>');
  });

  it('недоплата: платёж failed — «Запрошено у шлюза» всё равно называет сумму счёта', async () => {
    // Ревью 2026-09-25, ось E: именно на недоплате оператор сверяет, сколько
    // просили и сколько пришло, а строка исчезала вместе с живым платежом.
    h.detail.mockResolvedValue(
      detail({
        order: { ...detail().order, status: 'failed', paidAt: null, fulfilledAt: null },
        hasSucceededPayment: false,
        promo: promo({ status: 'reserved' }),
        payments: [payment(2595_00, 'failed')],
      }),
    );

    const html = await render();

    expect(html).toContain('<strong>2 595 ₽</strong>');
  });

  it('история заказа подписывает события скидок человеческими словами', async () => {
    h.detail.mockResolvedValue(
      detail({
        events: [
          {
            id: 'e1',
            eventType: 'promo_spent',
            fromStatus: null,
            toStatus: null,
            actorType: 'system',
            actorId: null,
            payload: null,
            createdAt: at,
          },
        ],
      }),
    );

    const html = await render();

    expect(html).toContain('Промокод израсходован');
    expect(html).not.toContain('promo_spent');
  });
});
