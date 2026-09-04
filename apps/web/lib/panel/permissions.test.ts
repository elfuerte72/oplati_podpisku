import { describe, expect, it } from 'vitest';

import {
  PANEL_CAPABILITIES,
  PANEL_SECTIONS,
  PANEL_SECTION_GROUPS,
  canAccess,
  groupedSectionsFor,
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
    for (const cap of ['orders', 'clients', 'holds', 'pending', 'support', 'fulfillment', 'feedback'] as const) {
      expect(canAccess('operator', cap)).toBe(true);
    }
  });

  it('партнёрские деньги и персонал — только владельцу', () => {
    expect(canAccess('operator', 'partners')).toBe(false);
    expect(canAccess('operator', 'staff')).toBe(false);
  });

  it('аналитика, AI-аналитик и тексты воронки — инструменты владельца (панель v2, ветки A–C)', () => {
    for (const cap of ['analytics', 'ai', 'texts'] as const) {
      expect(canAccess('admin', cap)).toBe(true);
      expect(canAccess('operator', cap)).toBe(false);
    }
    // Разделы ВИДНЫ менеджеру в меню, но помечены недоступными (спека §4.3).
    const sections = sectionsFor('operator');
    // Названия разведены намеренно: «Аналитика» и «Аналитик» различались одной
    // буквой и читались в меню опечаткой, а не двумя разными инструментами.
    expect(sections.find((s) => s.href === '/admin/analytics')).toMatchObject({
      allowed: false,
      title: 'Отчёты',
    });
    expect(sections.find((s) => s.href === '/admin/ai')).toMatchObject({ allowed: false, title: 'AI-аналитик' });
    expect(sections.find((s) => s.href === '/admin/texts')).toMatchObject({
      allowed: false,
      title: 'Тексты воронки',
    });
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

/**
 * Группировка меню (панель v3). Десять пунктов подряд читались списком, а не
 * структурой, и человек искал раздел перебором.
 */
describe('groupedSectionsFor', () => {
  it('группы идут в объявленном порядке и не теряют ни одного пункта', () => {
    const groups = groupedSectionsFor('admin');

    expect(groups.map((g) => g.group)).toEqual([...PANEL_SECTION_GROUPS]);
    // Плоский список — единственный источник: пункт, забытый в группировке,
    // пропал бы из меню, оставшись в правах.
    expect(groups.flatMap((g) => g.sections.map((s) => s.href))).toHaveLength(PANEL_SECTIONS.length);
    expect(new Set(groups.flatMap((g) => g.sections.map((s) => s.href)))).toEqual(
      new Set(PANEL_SECTIONS.map((s) => s.href)),
    );
  });

  it('менеджер видит те же группы и те же пункты — недоступные помечены', () => {
    const groups = groupedSectionsFor('operator');

    expect(groups.flatMap((g) => g.sections.map((s) => s.href))).toEqual(
      PANEL_SECTIONS.map((s) => s.href),
    );
    const manage = groups.find((g) => g.group === 'manage');
    expect(manage?.sections.find((s) => s.href === '/admin/partners')?.allowed).toBe(false);
  });

  it('рабочий стол — первый пункт и доступен обеим рабочим ролям', () => {
    // Пункт появился в v3: раньше на рабочий стол вела только ссылка-логотип,
    // и найти его можно было, только зная об этом.
    for (const role of ['admin', 'operator'] as const) {
      const first = groupedSectionsFor(role)[0]?.sections[0];
      expect(first).toMatchObject({ href: '/admin', allowed: true, title: 'Рабочий стол' });
    }
  });

  it('у каждой группы есть хотя бы один пункт, а название — у всех, кроме первой', () => {
    for (const group of groupedSectionsFor('admin')) {
      expect(group.sections.length).toBeGreaterThan(0);
      // Рабочий стол стоит первым пунктом БЕЗ заголовка: группа из одного
      // пункта, подписанная «Обзор», добавляла бы строку ради строки.
      if (group.group === 'overview') expect(group.title).toBeNull();
      else expect(group.title?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('срезы заказов лежат ВНУТРИ заказов, а не рядом с ними', () => {
    // Прежняя группа «Работа» держала шесть пунктов из одиннадцати, то есть не
    // отсекала ничего: «Ждут оплаты» и «Проверка платежей» стояли на одном
    // уровне со списком заказов, хотя это его срезы.
    const groups = groupedSectionsFor('admin');
    const orders = groups.find((g) => g.group === 'orders');
    expect(orders?.sections.map((s) => s.href)).toEqual(['/admin/orders', '/admin/pending', '/admin/holds']);

    const clients = groups.find((g) => g.group === 'clients');
    expect(clients?.sections.map((s) => s.href)).toEqual(['/admin/support', '/admin/feedback']);
  });

  it('каждая группа названа сущностью и не повторяет название своего пункта', () => {
    // «Аналитика» внутри группы «Аналитика» читалась дублем; заголовок группы
    // обязан отвечать на вопрос «что это за пункты», а не повторять один из них.
    for (const group of groupedSectionsFor('admin')) {
      if (group.title === null) continue;
      expect(group.sections.map((s) => s.title)).not.toContain(group.title);
    }
  });
});
