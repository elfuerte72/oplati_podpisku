import { describe, expect, it } from 'vitest';

import { groupBadgeTotal, isDeskQuiet, menuBadges, type DeskSignals } from './desk';
import { groupedSectionsFor } from './permissions';

const CALM: DeskSignals = {
  pendingCount: 0,
  holdsCount: 0,
  balanceLow: false,
  unansweredSupportCount: 0,
};

/**
 * Рабочий стол (тикет 08). Требование спеки §5.1 звучит непривычно: экран
 * обязан быть ПУСТЫМ в норме и обязан об этом сказать.
 */
describe('isDeskQuiet', () => {
  it('ничего не требует внимания — это «всё спокойно», а не поломка', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: false })).toBe(true);
  });

  it('недожатый заказ снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 1, holdsCount: 0, balanceLow: false })).toBe(false);
  });

  it('холд банка снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 1, balanceLow: false })).toBe(false);
  });

  it('низкий баланс тревожен даже при полном отсутствии заказов', () => {
    // Пополнение VCC приходит T+1: «заказов нет, значит всё хорошо» — ровно то
    // рассуждение, из-за которого 14 августа упал оплаченный заказ на 11 680 ₽.
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: true })).toBe(false);
  });

  it('обращение без ответа снимает спокойствие', () => {
    expect(isDeskQuiet({ ...CALM, unansweredSupportCount: 1 })).toBe(false);
  });

  it('«не смотрели» — это НЕ «спокойно»', () => {
    // Роль без права на раздел не видит ни одной карточки. Фраза «недожатых
    // заказов нет, банк ничего не держит» была бы утверждением о том, чего мы
    // не проверяли.
    expect(isDeskQuiet({ ...CALM, pendingCount: null, holdsCount: 0, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: null, balanceLow: false })).toBe(false);
    expect(isDeskQuiet({ ...CALM, pendingCount: 0, holdsCount: 0, balanceLow: null })).toBe(false);
    expect(isDeskQuiet({ ...CALM, unansweredSupportCount: null })).toBe(false);
  });
});

/**
 * Счётчики в меню (редизайн, тикет 02). Панель action-oriented: «есть ли
 * работа» должно быть видно из меню, а не выясняться обходом разделов.
 */
describe('menuBadges', () => {
  it('число работы показывается у своего раздела', () => {
    expect(menuBadges('operator', { pending: 4, holds: 1, support: 2, feedback: 3 })).toEqual({
      pending: 4,
      holds: 1,
      support: 2,
      feedback: 3,
    });
  });

  it('ноль не показывается — ноль не выглядит как задача', () => {
    expect(menuBadges('admin', { pending: 0, holds: 0, support: 0, feedback: 0 })).toEqual({});
  });

  it('«не получили» (null) отличается от нуля и тоже не показывается', () => {
    // База не ответила — счётчика нет; «0» здесь был бы утверждением о том,
    // чего мы не проверяли.
    expect(menuBadges('admin', { pending: null, holds: null, support: 3, feedback: null })).toEqual({
      support: 3,
    });
  });

  it('раздел, закрытый роли, счётчика не получает даже при известном числе', () => {
    // Роль без прав (`supervisor` не выдаётся) не должна видеть числа по
    // разделам, которые всё равно не откроет.
    expect(menuBadges('supervisor', { pending: 4, holds: 1, support: 2, feedback: 3 })).toEqual({});
  });

  it('бейджи «Проверка платежей» и «Обратная связь» видны и владельцу, и менеджеру (панель v2)', () => {
    for (const role of ['admin', 'operator'] as const) {
      expect(menuBadges(role, { pending: 0, holds: 2, support: 0, feedback: 5 })).toEqual({
        holds: 2,
        feedback: 5,
      });
    }
  });
});

/**
 * Число у свёрнутой группы меню (панель v3.1). Настройка «убрать редкое с
 * глаз» не должна прятать работу, поэтому свёрнутая группа показывает сумму
 * своих пунктов — и обязана считать её теми же правилами, что и пункты.
 */
describe('groupBadgeTotal', () => {
  const counts = { pending: 4, holds: 1, support: 2, feedback: 3 } as const;

  it('складывает числа пунктов группы и не трогает пункты без счётчика', () => {
    const groups = groupedSectionsFor('admin');
    const orders = groups.find((g) => g.group === 'orders')!;
    const clients = groups.find((g) => g.group === 'clients')!;
    const analytics = groups.find((g) => g.group === 'analytics')!;
    const badges = menuBadges('admin', counts);

    // «Все заказы» счётчика не имеет — в сумму входят только срезы.
    expect(groupBadgeTotal(badges, orders.sections)).toBe(4 + 1);
    expect(groupBadgeTotal(badges, clients.sections)).toBe(2 + 3);
    // У «Аналитики» счётчиков нет вовсе — ноль, бейдж не рисуется.
    expect(groupBadgeTotal(badges, analytics.sections)).toBe(0);
  });

  it('раздел, закрытый роли, в сумму группы не попадает', () => {
    // Сумма считается ПОВЕРХ `menuBadges`, а не из сырых чисел: иначе группа
    // показывала бы менеджеру работу по разделу, который он не откроет, и
    // число группы расходилось бы с суммой видимых пунктов.
    const orders = groupedSectionsFor('supervisor').find((g) => g.group === 'orders')!;
    expect(groupBadgeTotal(menuBadges('supervisor', counts), orders.sections)).toBe(0);
  });

  it('число группы никогда не больше суммы видимых пунктов', () => {
    for (const role of ['admin', 'operator'] as const) {
      const badges = menuBadges(role, counts);
      for (const group of groupedSectionsFor(role)) {
        const visible = group.sections.reduce(
          (sum, s) => sum + (badges[s.capability as keyof typeof badges] ?? 0),
          0,
        );
        expect(groupBadgeTotal(badges, group.sections)).toBe(visible);
      }
    }
  });
});
