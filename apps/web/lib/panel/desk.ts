import type { StaffRole } from '@oplati/db';

import { canAccess, type PanelSection } from './permissions';

/**
 * Рабочий стол панели (тикет 08) — решение «что показать», отделённое от
 * разметки.
 *
 * ⚠️ Главное правило экрана: **пустой стол — это норма, а не поломка.** На
 * 16 августа живых заказов было ноль, холдов ноль, обращений четыре за три
 * месяца. Экран обязан говорить «всё спокойно» — иначе менеджер каждое утро
 * решает, что панель сломалась, и идёт проверять её вместо работы.
 *
 * ⚠️ Модуль читают и серверная страница, и тесты: ни Next, ни env, ни БД.
 */

export type DeskSignals = {
  /**
   * Сколько недожатых заказов. `null` — НЕ СМОТРЕЛИ (у роли нет права), и это
   * принципиально другое состояние, чем ноль.
   */
  pendingCount: number | null;
  /** Сколько холдов банка. `null` — не смотрели. */
  holdsCount: number | null;
  /** Баланс карточного счёта ниже порога. `null` — не смотрели/не получили. */
  balanceLow: boolean | null;
  /** Обращений без ответа оператора. `null` — не смотрели. */
  unansweredSupportCount: number | null;
};

/**
 * Спокойно ли сейчас. «Спокойно» — это отсутствие СИГНАЛОВ, а не отсутствие
 * данных.
 *
 * ⚠️ Неизвестный сигнал спокойствия не даёт: роль без права на раздел не видит
 * ни одной карточки, и фраза «недожатых заказов нет, банк ничего не держит»
 * была бы утверждением о том, чего мы не проверяли. Ноль и «не смотрели»
 * различаются намеренно (находка ревью).
 *
 * Баланс ниже порога тревожен даже при нулевых заказах: пополнение приходит на
 * следующий день, а рассуждение «заказов нет, значит всё хорошо» — ровно то,
 * из-за которого 14 августа упал оплаченный заказ на 11 680 ₽.
 */
export function isDeskQuiet(signals: DeskSignals): boolean {
  if (signals.pendingCount === null || signals.holdsCount === null) return false;
  if (signals.balanceLow === null || signals.unansweredSupportCount === null) return false;
  return (
    signals.pendingCount === 0 &&
    signals.holdsCount === 0 &&
    signals.unansweredSupportCount === 0 &&
    !signals.balanceLow
  );
}

/**
 * Счётчики в меню (редизайн, тикет 02).
 *
 * Панель отвечает на вопрос «что мне сделать сейчас», и число работы должно
 * быть видно ИЗ МЕНЮ, а не выясняться обходом разделов. Считается теми же
 * выборками, что питают рабочий стол, — здесь только решение «что показать».
 */
/**
 * Разделы, у которых есть счётчик. ЕДИНСТВЕННЫЙ список: от него выводятся и
 * тип чисел, и цикл ниже, и проверка в оболочке — добавить раздел, забыв одно
 * из трёх мест, нельзя.
 */
export const MENU_BADGE_SECTIONS = [
  'pending',
  // Счётчик «Проверка платежей» (панель v2, тикет 13): та же выборка, что у
  // экрана холдов, `count(*)` без потолка.
  'holds',
  'support',
  // Ответы на опросы и оценки за последние 24 ч (тикет 14): «просмотрено» не
  // заводим — это схема ради счётчика.
  'feedback',
] as const satisfies readonly PanelSection['capability'][];

export type MenuBadgeSection = (typeof MENU_BADGE_SECTIONS)[number];

export function isMenuBadgeSection(capability: string): capability is MenuBadgeSection {
  return (MENU_BADGE_SECTIONS as readonly string[]).includes(capability);
}

/** Числа по разделам. `null` — не получили (база не ответила), и это не ноль. */
export type MenuCounts = Record<MenuBadgeSection, number | null>;

/**
 * Какие числа рисовать рядом с пунктами меню.
 *
 * Ноль не показывается (ноль не выглядит как задача), `null` не показывается
 * (это «не получили», и «0» здесь был бы утверждением о том, чего мы не
 * проверяли), а раздел, закрытый роли, числа не получает вовсе — даже если
 * вызывающий его посчитал.
 */
export function menuBadges(
  role: StaffRole,
  counts: MenuCounts,
): Partial<Record<MenuBadgeSection, number>> {
  const badges: Partial<Record<MenuBadgeSection, number>> = {};
  for (const section of MENU_BADGE_SECTIONS) {
    if (!canAccess(role, section)) continue;
    const count = counts[section];
    if (count === null || count <= 0) continue;
    badges[section] = count;
  }
  return badges;
}

/**
 * Число у СВЁРНУТОЙ группы меню — сумма чисел её пунктов.
 *
 * Считается из того же `menuBadges`, что рисует числа у пунктов, а не из
 * сырых `counts`: правила «ноль не показывать», «не получили — не ноль» и
 * «закрытый роли раздел числа не получает» применяются один раз, и число
 * группы не может оказаться больше суммы видимых пунктов. Пункты без
 * счётчика (рабочий стол, отчёты) в сумму не входят. `0` — «нечего
 * показывать»: оболочка не рисует бейдж.
 */
export function groupBadgeTotal(
  badges: Partial<Record<MenuBadgeSection, number>>,
  sections: readonly Pick<PanelSection, 'capability'>[],
): number {
  let total = 0;
  for (const section of sections) {
    if (!isMenuBadgeSection(section.capability)) continue;
    total += badges[section.capability] ?? 0;
  }
  return total;
}
