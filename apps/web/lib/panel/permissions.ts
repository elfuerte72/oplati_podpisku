import type { StaffRole } from '@oplati/db';

import { SECTION_TITLES } from './labels';

/**
 * Права в панели: две роли и таблица возможностей.
 *
 * ⚠️ Проверка живёт В ОПЕРАЦИИ, а не в маршруте (спека §4.3). Разделы владельца
 * ВИДНЫ менеджеру в меню и отдают объясняющую заглушку: скрывать пункт значило
 * бы полагаться на то, что менеджер не наберёт адрес руками.
 *
 * Владелец ждёт наёмных менеджеров в ближайшие месяцы, поэтому разделение
 * пишется боевым с первого дня, а не заглушкой.
 */

export const PANEL_CAPABILITIES = [
  /** Список заказов и карточка заказа. */
  'orders',
  /** Карточка клиента. */
  'clients',
  /** Антифрод-холды Freekassa и баланс карточного счёта. */
  'holds',
  /** Недожатые заказы и напоминание об оплате. */
  'pending',
  /** Переписка и ответ клиенту. */
  'support',
  /**
   * Ручное исполнение заказа. Остаётся менеджеру НАМЕРЕННО: надзор работает
   * лучше запрета — каждое действие пишется в `order_events` с именем
   * сотрудника, а журнал append-only на уровне триггера БД.
   */
  'fulfillment',
  /** Партнёры и заявки на вывод — реальные деньги. */
  'partners',
  /** Управление персоналом. */
  'staff',
  /**
   * Раздел «Аналитика»: графики по деньгам, воронке и продукту (спека
   * `.scratch/admin-panel-v2/`, ветка A). Инструмент владельца — менеджеру
   * оборот компании ни к чему.
   */
  'analytics',
] as const;

export type PanelCapability = (typeof PANEL_CAPABILITIES)[number];

/**
 * Что умеет роль. `Record<..., readonly PanelCapability[]>` обязывает описать
 * КАЖДУЮ роль enum'а: «всё, что не admin, — менеджер» молча выдало бы права
 * строке с ролью `supervisor`, которую панель не заводит.
 */
const CAPABILITIES_BY_ROLE: Record<StaffRole, readonly PanelCapability[]> = {
  admin: PANEL_CAPABILITIES,
  operator: ['orders', 'clients', 'holds', 'pending', 'support', 'fulfillment'],
  // Роль не выдаётся (спека §2). Строка с ней в базе прав не получает — но и
  // доступ не «падает в менеджера» по невнимательности.
  supervisor: [],
};

export function canAccess(role: StaffRole, capability: PanelCapability): boolean {
  return CAPABILITIES_BY_ROLE[role].includes(capability);
}

export type PanelSection = {
  href: string;
  /**
   * Право раздела — оно же ключ названия в словаре (`SECTION_TITLES`): пункт
   * меню без названия или с чужим названием не собирается по типу, а не
   * ловится глазами.
   */
  capability: keyof typeof SECTION_TITLES;
};

/**
 * Меню панели. Порядок — по частоте использования: сначала то, что требует
 * действия сейчас, партнёры и персонал в конце.
 */
export const PANEL_SECTIONS: readonly PanelSection[] = [
  { href: '/admin/orders', capability: 'orders' },
  { href: '/admin/pending', capability: 'pending' },
  { href: '/admin/holds', capability: 'holds' },
  { href: '/admin/support', capability: 'support' },
  { href: '/admin/analytics', capability: 'analytics' },
  { href: '/admin/partners', capability: 'partners' },
  { href: '/admin/staff', capability: 'staff' },
];

export type PanelSectionForRole = PanelSection & { title: string; allowed: boolean };

/** Меню для роли: показываем ВСЁ, помечая недоступное (см. заголовок). */
export function sectionsFor(role: StaffRole): PanelSectionForRole[] {
  return PANEL_SECTIONS.map((section) => ({
    ...section,
    title: SECTION_TITLES[section.capability],
    allowed: canAccess(role, section.capability),
  }));
}

/**
 * «Вернуть помощнику» — только ведущему или админу.
 *
 * Чужой разговор возвращать нельзя по той же причине, по какой нельзя в нём
 * отвечать: решение «я закончил» принимает тот, кто вёл. Админ — исключение:
 * сотрудник ушёл в отпуск, а разговор висит.
 */
export function canReturnToAi(input: {
  actorId: string;
  actorRole: StaffRole;
  assignedOperatorId: string | null;
}): boolean {
  if (input.actorRole === 'admin') return true;
  return input.assignedOperatorId === null || input.assignedOperatorId === input.actorId;
}
