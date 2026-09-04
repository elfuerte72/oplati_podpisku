import type { StaffRole } from '@oplati/db';

import { SECTION_GROUP_TITLES, SECTION_TITLES } from './labels';

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
  /**
   * Рабочий стол. Права как такового не несёт — он есть у всех, кто вошёл, а
   * показывает ровно то, на что у роли есть право (`desk.ts` различает ноль и
   * «не смотрели»). Заведён капабилити ради единообразия меню: пункт без
   * `capability` не собрался бы по типу и не получил бы названия из словаря.
   */
  'desk',
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
  /**
   * Раздел «Аналитик»: чат с AI, который пишет и выполняет SQL под read-only
   * ролью (ветка B). Каждый вопрос стоит денег провайдеру — только владелец.
   */
  'ai',
  /**
   * Раздел «Тексты воронки»: формулировки сообщений маскота правятся без
   * деплоя (ветка C). Голос продукта — решение владельца, не операционка.
   */
  'texts',
  /**
   * Лента ответов на опросы и оценок (ветка D). Операционка: связаться с
   * недовольным клиентом — работа менеджера, поэтому и ему.
   */
  'feedback',
] as const;

export type PanelCapability = (typeof PANEL_CAPABILITIES)[number];

/**
 * Что умеет роль. `Record<..., readonly PanelCapability[]>` обязывает описать
 * КАЖДУЮ роль enum'а: «всё, что не admin, — менеджер» молча выдало бы права
 * строке с ролью `supervisor`, которую панель не заводит.
 */
const CAPABILITIES_BY_ROLE: Record<StaffRole, readonly PanelCapability[]> = {
  admin: PANEL_CAPABILITIES,
  operator: ['desk', 'orders', 'clients', 'holds', 'pending', 'support', 'fulfillment', 'feedback'],
  // Роль не выдаётся (спека §2). Строка с ней в базе прав не получает — но и
  // доступ не «падает в менеджера» по невнимательности.
  supervisor: [],
};

export function canAccess(role: StaffRole, capability: PanelCapability): boolean {
  return CAPABILITIES_BY_ROLE[role].includes(capability);
}

/**
 * Группы меню. Ключ — он же ключ заголовка в словаре, а тип берётся ИЗ
 * словаря: группа без названия не собирается, и второго списка названий рядом
 * не заводится (инвариант 10 — зеркало лучше убрать, чем сверять).
 *
 * Порядок здесь — порядок групп на экране, и он же задаёт смысл: сверху то,
 * чем занимаются каждый день, снизу то, куда заходят раз в месяц.
 */
export const PANEL_SECTION_GROUPS = ['overview', 'orders', 'clients', 'analytics', 'manage'] as const satisfies
  readonly (keyof typeof SECTION_GROUP_TITLES)[];

export type PanelSectionGroup = (typeof PANEL_SECTION_GROUPS)[number];

export type PanelSection = {
  href: string;
  /**
   * Право раздела — оно же ключ названия в словаре (`SECTION_TITLES`): пункт
   * меню без названия или с чужим названием не собирается по типу, а не
   * ловится глазами.
   */
  capability: keyof typeof SECTION_TITLES;
  /** Группа меню. Пункт без группы не собирается — «прочее» копило бы разделы. */
  group: PanelSectionGroup;
};

/**
 * Меню панели. Порядок — по частоте использования: сначала то, что требует
 * действия сейчас, настройки и персонал в конце.
 *
 * ⚠️ Плоский список остаётся ЕДИНСТВЕННЫМ источником: группировка считается
 * из него (`groupedSectionsFor`), а не описывается вторым списком рядом —
 * два списка разъезжаются молча, и раздел пропадает из меню, оставшись в
 * правах (инвариант 10 — зеркало предпочтительно убрать, а не сверять).
 *
 * Группы названы сущностью, а не родом занятий: «Ждут оплаты» и «Проверка
 * платежей» — это срезы ЗАКАЗОВ, а не отдельные миры, и стоя рядом с общим
 * списком заказов они читаются как его продолжение. Прежняя группа «Работа»
 * держала шесть пунктов из одиннадцати и потому не отсекала ничего.
 */
export const PANEL_SECTIONS: readonly PanelSection[] = [
  { href: '/admin', capability: 'desk', group: 'overview' },
  { href: '/admin/orders', capability: 'orders', group: 'orders' },
  { href: '/admin/pending', capability: 'pending', group: 'orders' },
  { href: '/admin/holds', capability: 'holds', group: 'orders' },
  { href: '/admin/support', capability: 'support', group: 'clients' },
  { href: '/admin/feedback', capability: 'feedback', group: 'clients' },
  { href: '/admin/analytics', capability: 'analytics', group: 'analytics' },
  { href: '/admin/ai', capability: 'ai', group: 'analytics' },
  { href: '/admin/partners', capability: 'partners', group: 'manage' },
  { href: '/admin/texts', capability: 'texts', group: 'manage' },
  { href: '/admin/staff', capability: 'staff', group: 'manage' },
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

export type PanelSectionGroupForRole = {
  group: PanelSectionGroup;
  /** `null` — группа без заголовка (рабочий стол стоит первым пунктом сам). */
  title: string | null;
  sections: PanelSectionForRole[];
};

/**
 * То же меню, разложенное по группам — в порядке `PANEL_SECTION_GROUPS`.
 *
 * Пустая группа не возвращается: сегодня таких нет (недоступный раздел всё
 * равно виден с пометкой), но группа-заголовок без единого пункта под ним
 * читалась бы как поломка.
 */
export function groupedSectionsFor(role: StaffRole): PanelSectionGroupForRole[] {
  const sections = sectionsFor(role);
  return PANEL_SECTION_GROUPS.map((group) => ({
    group,
    title: SECTION_GROUP_TITLES[group],
    sections: sections.filter((section) => section.group === group),
  })).filter((entry) => entry.sections.length > 0);
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
