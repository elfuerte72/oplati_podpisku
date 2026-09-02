import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Экран «Тексты воронки» (тикет 11): гейт роли, строки реестра по группам,
 * пометка «изменено» с автором и историей у переопределённых ключей, «по
 * умолчанию» и отсутствие кнопки сброса у нетронутых.
 */

const h = vi.hoisted(() => ({
  access: vi.fn(),
  overrides: vi.fn(),
  revisions: vi.fn(),
}));

vi.mock('@/lib/panel/guard', () => ({ panelPageAccess: h.access }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  listFunnelTextOverrides: h.overrides,
  listRecentFunnelTextRevisions: h.revisions,
}));
vi.mock('@/components/panel/PanelShell', () => ({
  PanelShell: ({ children }: { children: ReactNode }) => createElement('div', { 'data-shell': '' }, children),
  PanelForbidden: ({ title }: { title: string }) => createElement('div', { 'data-forbidden': title }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import PanelTextsPage from './page';
import { FUNNEL_TEXTS } from '@/lib/funnel/texts';

const admin = { id: 's1', email: 'o@example.com', displayName: 'Владелец', role: 'admin' as const, telegramId: '1', lastLoginAt: null };

async function render() {
  return renderToStaticMarkup(await PanelTextsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ allowed: true, actor: admin });
  h.overrides.mockResolvedValue([]);
  h.revisions.mockResolvedValue([]);
});

describe('/admin/texts', () => {
  it('оператор видит заглушку, выборки не зовутся', async () => {
    h.access.mockResolvedValue({ allowed: false, actor: { ...admin, role: 'operator' } });
    const html = await render();
    expect(html).toContain('data-forbidden="Тексты воронки"');
    expect(h.overrides).not.toHaveBeenCalled();
  });

  it('без переопределений — каждая строка реестра «по умолчанию», кнопки сброса нет', async () => {
    const html = await render();
    for (const spec of FUNNEL_TEXTS) expect(html).toContain(`<code>${spec.key}</code>`);
    expect(html.match(/По умолчанию/g)?.length).toBeGreaterThanOrEqual(FUNNEL_TEXTS.length);
    expect(html).not.toContain('Вернуть по умолчанию');
    expect(html).not.toContain('История правок');
    // Дефолт подставлен в поле как значение.
    expect(html).toContain('Похоже, оплата не сложилась.');
  });

  it('с переопределением — «Изменено» с автором, кнопка сброса и история «было → стало»', async () => {
    h.overrides.mockResolvedValue([
      {
        key: 'expired_survey.body',
        value: 'Свой текст опроса',
        updatedAt: new Date('2026-09-02T10:00:00Z'),
        updatedBy: 's1',
        updatedByName: 'Владелец',
      },
    ]);
    h.revisions.mockResolvedValue([
      {
        id: 'r1',
        key: 'expired_survey.body',
        oldValue: null,
        newValue: 'Свой текст опроса',
        staffId: 's1',
        staffName: 'Владелец',
        createdAt: new Date('2026-09-02T10:00:00Z'),
      },
    ]);

    const html = await render();

    expect(html).toContain('Изменено');
    expect(html).toContain('Владелец');
    expect(html).toContain('Свой текст опроса');
    expect(html.match(/Вернуть по умолчанию/g)?.length).toBe(1);
    expect(html).toContain('История правок');
    // История по всем ключам — одним запросом, а не по запросу на ключ.
    expect(h.revisions).toHaveBeenCalledTimes(1);
  });

  it('после возврата к дефолту история не исчезает: ключ «по умолчанию», но с раскрывашкой правок', async () => {
    h.overrides.mockResolvedValue([]);
    h.revisions.mockResolvedValue([
      {
        id: 'r2',
        key: 'common.thanks',
        oldValue: 'Своё спасибо',
        newValue: null,
        staffId: 's1',
        staffName: 'Владелец',
        createdAt: new Date('2026-09-02T11:00:00Z'),
      },
      {
        id: 'r1',
        key: 'common.thanks',
        oldValue: null,
        newValue: 'Своё спасибо',
        staffId: 's1',
        staffName: 'Владелец',
        createdAt: new Date('2026-09-02T10:00:00Z'),
      },
    ]);

    const html = await render();

    expect(html).not.toContain('Вернуть по умолчанию');
    expect(html.match(/История правок/g)?.length).toBe(1);
    expect(html).toContain('возврат по умолчанию');
    expect(html).toContain('Своё спасибо');
  });

  it('обязательные подстановки и лимит показаны рядом со строкой', async () => {
    const html = await render();
    expect(html).toContain('Обязательные подстановки: {service}');
    expect(html).toContain('Обязательные подстановки: {link}');
    expect(html).toContain('Не длиннее 64 символов');
    expect(html).toContain('Не длиннее 4096 символов');
  });
});
