import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readPanelActor: vi.fn(),
}));

vi.mock('./session', () => ({ readPanelActor: h.readPanelActor }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { guardPanelOperation, panelPageAccess, requirePanelActor } from './guard';

function actor(role: 'admin' | 'operator' | 'supervisor') {
  return {
    id: 'staff-1',
    email: 'x@example.com',
    displayName: 'Кто-то',
    role,
    telegramId: '1',
    lastLoginAt: null,
  };
}

/**
 * Гейт операций панели.
 *
 * Спека §4.3: проверка прав живёт В ОПЕРАЦИИ, а не в маршруте. Значит менеджер
 * не должен выполнить операцию владельца и прямым запросом мимо интерфейса —
 * ровно это здесь и проверяется.
 */
describe('guardPanelOperation', () => {
  beforeEach(() => {
    h.readPanelActor.mockReset();
  });

  it('владелец проходит в операцию владельца', async () => {
    h.readPanelActor.mockImplementation(async () => actor('admin'));

    const res = await guardPanelOperation('partners');

    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.actor.role).toBe('admin');
  });

  it('менеджер проходит в операционные разделы', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    expect(await guardPanelOperation('orders')).toMatchObject({ ok: true });
    expect(await guardPanelOperation('fulfillment')).toMatchObject({ ok: true });
  });

  it('менеджер НЕ выполняет операцию владельца прямым запросом', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    const res = await guardPanelOperation('partners');

    expect(res).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });

  it('не вошедший получает 401, а не 403 — это разные вещи для UI', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    const res = await guardPanelOperation('orders');

    expect(res).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
  });

  it('роль supervisor прав не получает', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    expect(await guardPanelOperation('orders')).toMatchObject({ ok: false, status: 403 });
  });

  it('отказ не рассказывает, что именно закрыто', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    const res = await guardPanelOperation('staff');

    expect(JSON.stringify(res)).not.toContain('staff-1');
  });
});

describe('panelPageAccess (гейт страницы)', () => {
  beforeEach(() => {
    h.readPanelActor.mockReset();
  });

  it('не вошедшего уводит на страницу входа', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    await expect(panelPageAccess('orders')).rejects.toThrow('REDIRECT:/admin/login');
  });

  it('менеджер ВИДИТ раздел владельца, но помечен как без доступа', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    const res = await panelPageAccess('partners');

    // Не редирект и не 404: экран покажет объясняющую заглушку внутри панели,
    // с меню и «кто вошёл». Пустота выглядела бы поломкой.
    expect(res).toMatchObject({ allowed: false });
    expect(res.actor.role).toBe('operator');
  });

  it('свой раздел открывается', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    expect(await panelPageAccess('orders')).toMatchObject({ allowed: true });
  });

  it('роль без прав не получает раздел заказов — контракт держится и на странице', async () => {
    h.readPanelActor.mockImplementation(async () => actor('supervisor'));

    expect(await panelPageAccess('orders')).toMatchObject({ allowed: false });
  });
});

describe('requirePanelActor (страница без отдельного права)', () => {
  beforeEach(() => {
    h.readPanelActor.mockReset();
  });

  it('вошедшего пускает', async () => {
    h.readPanelActor.mockImplementation(async () => actor('operator'));

    expect(await requirePanelActor()).toMatchObject({ role: 'operator' });
  });

  it('не вошедшего уводит на страницу входа', async () => {
    h.readPanelActor.mockImplementation(async () => null);

    await expect(requirePanelActor()).rejects.toThrow('REDIRECT:/admin/login');
  });
});
