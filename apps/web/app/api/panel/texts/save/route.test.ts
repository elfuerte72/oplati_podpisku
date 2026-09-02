import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сохранение и сброс текста воронки из панели (тикет 11): гейты, валидация по
 * реестру с кодами причин, запись через репозиторий и сброс памятки реестра.
 */

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
  overrides: [] as { key: string; value: string; updatedAt: Date; updatedBy: null; updatedByName: null }[],
  save: vi.fn(),
  reset: vi.fn(),
  invalidate: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/panel/session', () => ({ readPanelActor: h.readPanelActor }));
vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'PANEL_HOST' ? 'admin.oplatishka.com' : undefined) },
  ),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'admin.oplatishka.com' }),
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  listFunnelTextOverrides: vi.fn(async () => h.overrides),
  saveFunnelText: h.save,
  resetFunnelText: h.reset,
}));
vi.mock('@/lib/funnel/texts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/funnel/texts')>()),
  invalidateFunnelTexts: h.invalidate,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));

import { POST as save } from './route.ts';
import { POST as reset } from '../reset/route.ts';

const STAFF_ID = '00000000-0000-4000-8000-0000000000ff';

function actor(role: 'admin' | 'operator') {
  return { id: STAFF_ID, email: 'o@example.com', displayName: 'Владелец', role, telegramId: '1', lastLoginAt: null };
}

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://admin.oplatishka.com/api/panel/texts/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://admin.oplatishka.com', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.readPanelActor.mockReset();
  h.readPanelActor.mockImplementation(async () => actor('admin'));
  h.overrides = [];
  h.save.mockReset();
  h.save.mockImplementation(async () => ({ previous: null, current: 'x' }));
  h.reset.mockReset();
  h.reset.mockImplementation(async () => ({ changed: true, previous: 'x' }));
  h.invalidate.mockClear();
  h.captureException.mockClear();
});

describe('POST /api/panel/texts/save', () => {
  it('оператор → 403, ничего не пишется', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));
    const res = await save(request('save', { key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('неизвестный ключ → 400 unknown_key', async () => {
    const res = await save(request('save', { key: 'ghost.key', value: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_key' });
  });

  it('текст без {link} для referral_nudge.body → 422 missing_placeholder', async () => {
    const res = await save(request('save', { key: 'referral_nudge.body', value: 'Партнёрка без ссылки' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'missing_placeholder', placeholder: 'link' });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('{lnk} вместо {link} → 422 unknown_placeholder', async () => {
    const res = await save(request('save', { key: 'referral_nudge.body', value: 'Ссылка {lnk} и {link}' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown_placeholder', placeholder: 'lnk' });
  });

  it('4097 символов → 422 too_long с лимитом', async () => {
    const res = await save(request('save', { key: 'common.thanks', value: 'а'.repeat(4097) }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'too_long', max: 4096 });
  });

  it('подпись, совпадающая с соседней (с учётом сохранённых соседей) → 422 duplicate_label', async () => {
    h.overrides = [
      { key: 'expired_survey.answer.changed', value: 'Своё', updatedAt: new Date(), updatedBy: null, updatedByName: null },
    ];
    const res = await save(request('save', { key: 'expired_survey.answer.price', value: 'Своё' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'duplicate_label' });
  });

  it('счастливый путь: пишет оверлей с автором, обрезанный текст, зовёт инвалидацию', async () => {
    const res = await save(request('save', { key: 'order_rating.body', value: '  Оцените {service}  ' }));
    expect(res.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(expect.anything(), {
      key: 'order_rating.body',
      value: 'Оцените {service}',
      staffId: STAFF_ID,
    });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('сбой БД при записи → 503 + Sentry, памятка не сбрасывается', async () => {
    h.save.mockImplementation(async () => {
      throw new Error('connection terminated');
    });
    const res = await save(request('save', { key: 'common.thanks', value: 'Спасибо' }));
    expect(res.status).toBe(503);
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('чужой Origin → 403', async () => {
    const res = await save(request('save', { key: 'common.thanks', value: 'x' }, { origin: 'https://www.oplatishka.com' }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/panel/texts/reset', () => {
  it('оператор → 403', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));
    expect((await reset(request('reset', { key: 'common.thanks' }))).status).toBe(403);
  });

  it('неизвестный ключ → 400', async () => {
    expect((await reset(request('reset', { key: 'nope' }))).status).toBe(400);
    expect(h.reset).not.toHaveBeenCalled();
  });

  it('сброс зовёт репозиторий с автором и инвалидирует памятку; отдаёт changed', async () => {
    const res = await reset(request('reset', { key: 'common.thanks' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true });
    expect(h.reset).toHaveBeenCalledWith(expect.anything(), { key: 'common.thanks', staffId: STAFF_ID });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
});
