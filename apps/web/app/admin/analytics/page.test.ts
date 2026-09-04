import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Экран «Аналитика» (панель v2, тикеты 01 и 03): гейт роли, разбор периода из
 * адреса и три блока из выборок репозитория. Сами выборки проверены на PGlite в
 * `packages/db`; здесь они подменены фикстурой — страница проверяется как
 * функция «строки репозитория → разметка».
 */

const h = vi.hoisted(() => ({
  access: vi.fn(),
  revenueByDay: vi.fn(),
  revenueSummary: vi.fn(),
  funnelByPeriod: vi.fn(),
  topServicesByPaidOrders: vi.fn(),
  catalogClicksByService: vi.fn(),
  activeSubjectsByDay: vi.fn(),
}));

vi.mock('@/lib/panel/guard', () => ({ panelPageAccess: h.access }));

vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({}) as unknown,
    revenueByDay: h.revenueByDay,
    revenueSummary: h.revenueSummary,
    funnelByPeriod: h.funnelByPeriod,
    topServicesByPaidOrders: h.topServicesByPaidOrders,
    catalogClicksByService: h.catalogClicksByService,
    activeSubjectsByDay: h.activeSubjectsByDay,
  };
});

// Оболочка тянет `<Suspense>` с асинхронным счётчиком меню — в строку такое не
// рендерится. Здесь проверяется страница, а не оболочка.
vi.mock('@/components/panel/PanelShell', () => ({
  PanelShell: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-shell': '' }, children),
  PanelForbidden: ({ title }: { title: string }) =>
    createElement('div', { 'data-forbidden': title }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

import PanelAnalyticsPage from './page';

const admin = {
  id: 'staff-1',
  email: 'owner@example.com',
  displayName: 'Владелец',
  role: 'admin' as const,
  telegramId: '1',
  lastLoginAt: null,
};

function fixture() {
  h.revenueByDay.mockResolvedValue([
    { day: '2026-09-01', amountKopecks: 150_000, paidOrders: 1 },
    { day: '2026-09-02', amountKopecks: 0, paidOrders: 0 },
  ]);
  h.revenueSummary.mockResolvedValue({ amountKopecks: 150_000, paidOrders: 1, averageKopecks: 150_000 });
  h.funnelByPeriod.mockResolvedValue([
    { step: 1, name: 'page_view', title: 'Зашёл на сайт', subjects: 10 },
    { step: 2, name: 'catalog_open', title: 'Открыл список сервисов', subjects: 5 },
    { step: 3, name: 'service_click', title: 'Выбрал сервис', subjects: 0 },
    { step: 4, name: 'order_proposed', title: 'Оформил заказ', subjects: 1 },
  ]);
  h.topServicesByPaidOrders.mockResolvedValue([
    { serviceSlug: 'netflix', title: 'Netflix', orders: 1, amountKopecks: 150_000 },
    { serviceSlug: null, title: null, orders: 1, amountKopecks: 40_000 },
  ]);
  h.catalogClicksByService.mockResolvedValue([
    { serviceSlug: 'netflix', title: 'Netflix', clicks: 7, subjects: 3 },
    { serviceSlug: 'gone', title: null, clicks: 1, subjects: 1 },
  ]);
  h.activeSubjectsByDay.mockResolvedValue([
    { day: '2026-09-01', subjects: 4 },
    { day: '2026-09-02', subjects: 2 },
  ]);
}

function empty() {
  h.revenueByDay.mockResolvedValue([{ day: '2026-09-01', amountKopecks: 0, paidOrders: 0 }]);
  h.revenueSummary.mockResolvedValue({ amountKopecks: 0, paidOrders: 0, averageKopecks: 0 });
  h.funnelByPeriod.mockResolvedValue([{ step: 1, name: 'page_view', title: 'Зашёл', subjects: 0 }]);
  h.topServicesByPaidOrders.mockResolvedValue([]);
  h.catalogClicksByService.mockResolvedValue([]);
  h.activeSubjectsByDay.mockResolvedValue([{ day: '2026-09-01', subjects: 0 }]);
}

async function render(params: Record<string, string> = {}) {
  const element = await PanelAnalyticsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ allowed: true, actor: admin });
  fixture();
});

describe('/admin/analytics — доступ', () => {
  it('менеджер видит заглушку раздела владельца, выборки не зовутся', async () => {
    h.access.mockResolvedValue({ allowed: false, actor: { ...admin, role: 'operator' } });

    const html = await render();

    // Раздел называется «Отчёты»: «Аналитика» осталась названием ГРУППЫ меню,
    // а пункт и его заглушка называют то, что внутри.
    expect(html).toContain('data-forbidden="Отчёты"');
    expect(h.revenueSummary).not.toHaveBeenCalled();
  });
});

describe('/admin/analytics — период', () => {
  it('период из адреса уходит в выборки полуоткрытым окном по UTC', async () => {
    await render({ period: '7' });

    const range = h.revenueSummary.mock.calls[0]?.[1] as { since: string; until: string };
    const since = new Date(range.since);
    const until = new Date(range.until);
    expect(since.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    expect(until.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    expect((until.getTime() - since.getTime()) / 86_400_000).toBe(7);
    // Все шесть выборок получили ОДНО и то же окно.
    for (const fn of [
      h.revenueByDay,
      h.funnelByPeriod,
      h.topServicesByPaidOrders,
      h.catalogClicksByService,
      h.activeSubjectsByDay,
    ]) {
      expect(fn.mock.calls[0]?.[1]).toEqual(range);
    }
  });

  it('мусор в адресе → 30 дней, текущий период выделен в переключателе', async () => {
    const html = await render({ period: 'abc' });

    expect(html).toContain('href="/admin/analytics?period=30" aria-current="page"');
    expect(html).toContain('href="/admin/analytics?period=7"');
    expect(html).toContain('href="/admin/analytics?period=90"');
  });
});

describe('/admin/analytics — блоки', () => {
  it('деньги: три цифры в рублях, столбцы выручки и линия заказов', async () => {
    const html = await render();

    // Разделитель тысяч у `toLocaleString('ru-RU')` — неразрывный пробел.
    expect(html).toMatch(/1\u00a0500 ₽|1\u202f500 ₽/);
    expect(html).toContain('panel-chart__bar');
    expect(html).toContain('panel-chart__line');
  });

  it('воронка: семь строк с конверсией, прочерк там, где предыдущий шаг нулевой', async () => {
    const html = await render();

    expect(html).toContain('1. Зашёл на сайт');
    expect(html).toContain('<span class="panel-hbars__note">50 %</span>');
    // Шаг 4 идёт после нулевого шага 3 — конверсии нет.
    expect(html).toContain('<span class="panel-hbars__note">—</span>');
  });

  it('продукт: топ сервисов с «вне каталога», клики с архивным slug, активность', async () => {
    const html = await render();

    expect(html).toContain('Netflix');
    expect(html).toContain('Вне каталога');
    expect(html).toContain('gone · Сервис не в каталоге');
    expect(html).toContain('Активность по дням');
  });

  it('пустой период — тексты «данных нет» вместо графиков с нулевой осью', async () => {
    empty();

    const html = await render();

    expect(html).not.toContain('panel-chart__svg');
    expect(html.match(/За выбранный период данных нет\./g)?.length).toBe(5);
  });
});
