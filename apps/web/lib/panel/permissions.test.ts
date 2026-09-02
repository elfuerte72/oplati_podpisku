import { describe, expect, it } from 'vitest';

import {
  PANEL_CAPABILITIES,
  PANEL_SECTIONS,
  canAccess,
  sectionsFor,
} from './permissions';

/**
 * Разделение прав между владельцем (`admin`) и менеджером (`operator`).
 *
 * Проверка живёт В ОПЕРАЦИИ, а не в маршруте (спека §4.3), поэтому тут
 * проверяется сама таблица прав: она — единственный источник, из которого
 * растут и меню, и заглушки, и отказы операций.
 */
describe('canAccess', () => {
  it('владельцу доступно всё', () => {
    for (const cap of PANEL_CAPABILITIES) {
      expect(canAccess('admin', cap)).toBe(true);
    }
  });

  it('менеджер ведёт всю операционку', () => {
    for (const cap of ['orders', 'clients', 'holds', 'pending', 'support', 'fulfillment'] as const) {
      expect(canAccess('operator', cap)).toBe(true);
    }
  });

  it('партнёрские деньги и персонал — только владельцу', () => {
    expect(canAccess('operator', 'partners')).toBe(false);
    expect(canAccess('operator', 'staff')).toBe(false);
  });

  it('аналитика — инструмент владельца (панель v2, ветка A)', () => {
    expect(canAccess('admin', 'analytics')).toBe(true);
    expect(canAccess('operator', 'analytics')).toBe(false);
    // Раздел ВИДЕН менеджеру в меню, но помечен недоступным (спека §4.3).
    const section = sectionsFor('operator').find((s) => s.href === '/admin/analytics');
    expect(section).toMatchObject({ allowed: false, title: 'Аналитика' });
  });

  it('ручное исполнение остаётся менеджеру намеренно', () => {
    // Надзор работает лучше запрета: каждое действие пишется в order_events с
    // именем сотрудника, а журнал append-only на уровне триггера БД.
    expect(canAccess('operator', 'fulfillment')).toBe(true);
  });

  it('роль supervisor не заводится и прав не получает', () => {
    // Значение осталось в enum'е БД с прежней схемы (спека §2: роли supervisor
    // не делаем). Строка с ним не должна молча получить права менеджера.
    for (const cap of PANEL_CAPABILITIES) {
      expect(canAccess('supervisor', cap)).toBe(false);
    }
  });
});

describe('sectionsFor', () => {
  it('менеджер ВИДИТ разделы владельца в меню', () => {
    const sections = sectionsFor('operator');

    // Скрывать пункт нельзя: это полагалось бы на то, что менеджер не наберёт
    // адрес руками. Раздел виден и отдаёт объясняющую заглушку.
    expect(sections.map((s) => s.href)).toEqual(PANEL_SECTIONS.map((s) => s.href));
  });

  it('разделы владельца помечены как недоступные менеджеру', () => {
    const partners = sectionsFor('operator').find((s) => s.href === '/admin/partners');
    const orders = sectionsFor('operator').find((s) => s.href === '/admin/orders');

    expect(partners?.allowed).toBe(false);
    expect(orders?.allowed).toBe(true);
  });

  it('владельцу все разделы доступны', () => {
    expect(sectionsFor('admin').every((s) => s.allowed)).toBe(true);
  });

  it('каждый раздел меню опирается на право, а не на свой список', () => {
    for (const section of PANEL_SECTIONS) {
      expect(PANEL_CAPABILITIES).toContain(section.capability);
    }
  });
});
