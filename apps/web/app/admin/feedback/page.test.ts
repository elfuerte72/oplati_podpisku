import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Экран «Обратная связь» (тикет 14): менеджер видит раздел (не заглушку),
 * сводка с долей, лента с подписями ответов, подсветка оценок 1–3, ссылки на
 * клиента и заказ, оценка без заказа — без ссылки, «есть ещё» и страницы.
 */

const h = vi.hoisted(() => ({
  access: vi.fn(),
  summary: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/panel/guard', () => ({ panelPageAccess: h.access }));
vi.mock('@oplati/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oplati/db')>();
  return {
    ...actual,
    getDb: () => ({}),
    feedbackSummaryForPanel: h.summary,
    listClientFeedbackForPanel: h.list,
  };
});
vi.mock('@/components/panel/PanelShell', () => ({
  PanelShell: ({ children }: { children: ReactNode }) => createElement('div', { 'data-shell': '' }, children),
  PanelForbidden: ({ title }: { title: string }) => createElement('div', { 'data-forbidden': title }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

import PanelFeedbackPage from './page';

const operator = { id: 's1', email: 'o@example.com', displayName: 'Менеджер', role: 'operator' as const, telegramId: '1', lastLoginAt: null };

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await PanelFeedbackPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ allowed: true, actor: operator });
  h.summary.mockResolvedValue([
    { kind: 'expired_survey', sent: 4, answered: 1 },
    { kind: 'start_survey', sent: 0, answered: 0 },
    { kind: 'order_rating', sent: 2, answered: 2 },
  ]);
  h.list.mockResolvedValue({
    items: [
      {
        id: 'f1',
        createdAt: new Date('2026-09-02T10:00:00Z'),
        kind: 'order_rating',
        score: 2,
        answer: null,
        client: { id: 'u1', displayName: 'Клиент А', telegramId: '111' },
        order: { id: 'o1', shortId: 'ORD-AAAAA', serviceName: 'Netflix' },
      },
      {
        id: 'f2',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        kind: 'expired_survey',
        score: null,
        answer: 'howto',
        client: { id: 'u2', displayName: null, telegramId: '222' },
        order: null,
      },
    ],
    hasMore: true,
  });
});

describe('/admin/feedback', () => {
  it('менеджер видит раздел, а не заглушку', async () => {
    const html = await render();
    expect(html).not.toContain('data-forbidden');
    expect(html).toContain('Обратная связь');
  });

  it('сводка: доля ответов посчитана, при нуле отправок — прочерк', async () => {
    const html = await render();
    expect(html).toContain('25 %');
    expect(html).toContain('100 %');
    expect(html).toContain('Опрос: без заказа</td><td class="panel-num">0</td><td class="panel-num">0</td><td class="panel-num">—</td>');
  });

  it('лента: оценка 1–3 подсвечена, ответ опроса подписан словами, ссылки на клиента и заказ', async () => {
    const html = await render();
    expect(html).toContain('panel-status--danger">2 из 5');
    expect(html).toContain('Непонятно, как оплатить');
    expect(html).toContain('href="/admin/clients/u1"');
    expect(html).toContain('href="/admin/orders/ORD-AAAAA"');
    expect(html).toContain('Netflix');
    // Клиент без имени подписан telegram_id; ответ без заказа — прочерк.
    expect(html).toContain('>222<');
  });

  it('период и страница живут в адресе; «есть ещё» даёт ссылку дальше', async () => {
    const html = await render({ period: '7', page: '2' });
    expect(html).toContain('href="/admin/feedback?period=7" aria-current="page"');
    expect(html).toContain('href="/admin/feedback?period=7&amp;page=3"');
    expect(html).toContain('href="/admin/feedback?period=7"');
    const since = (h.list.mock.calls[0]?.[1] as { since: string; offset: number }).since;
    expect(since.endsWith('T00:00:00.000Z')).toBe(true);
    expect((h.list.mock.calls[0]?.[1] as { offset: number }).offset).toBe(50);
  });

  it('пустая лента — текст словаря', async () => {
    h.list.mockResolvedValue({ items: [], hasMore: false });
    const html = await render();
    expect(html).toContain('Ответов за период нет.');
  });
});
