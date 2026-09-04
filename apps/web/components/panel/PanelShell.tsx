import { cookies } from 'next/headers';
import Link from 'next/link';
import { Suspense } from 'react';

import { isMenuBadgeSection, menuBadges, type MenuBadgeSection } from '@/lib/panel/desk';
import { ACTION_TITLES, FORBIDDEN_TEXT, attentionLabel } from '@/lib/panel/labels';
import type { PanelActor } from '@/lib/panel/login';
import { readMenuCounts } from '@/lib/panel/menu-counts';
import { groupedSectionsFor, type PanelSectionForRole } from '@/lib/panel/permissions';
import { DENSITY_COOKIE, NAV_CLOSED_COOKIE, THEME_COOKIE, readClosedGroups, readDensity, readTheme } from '@/lib/panel/prefs';
import { staffRoleLabel } from '@/lib/panel/roles';
import { SIDEBAR_COOKIE, isSidebarCollapsed } from '@/lib/panel/sidebar';

import { LiveRefresh } from './LiveRefresh';
import { PanelIcon } from './PanelIcon';
import { PanelLayout } from './PanelLayout';
import { PanelNavGroup } from './PanelNavGroup';
import { PanelViewToggles } from './PanelViewToggles';

/**
 * Оболочка панели: боковое меню со счётчиками работы, «кто вошёл», выход.
 *
 * Меню вертикальное и сгруппированное. Группы названы СУЩНОСТЬЮ («Заказы»,
 * «Клиенты»), а не родом занятий: прежняя «Работа» держала шесть пунктов из
 * одиннадцати, то есть не отсекала ничего — человек всё равно читал список
 * целиком. Каждый пункт несёт значок (`PanelIcon`): одиннадцать одинаковых
 * строк глаз не запоминает, а в свёрнутом меню значок заменил две первые буквы
 * названия — «Пр» одинаково начинало проверку платежей, поддержку, партнёров
 * и персонал.
 *
 * ⚠️ Разделы владельца показываются менеджеру ТОЖЕ (спека §4.3) — с пометкой.
 * Скрывать пункт значило бы полагаться на то, что менеджер не наберёт адрес
 * руками; настоящая защита живёт в операции (`guardPanelOperation`).
 *
 * Счётчики в меню считаются на сервере теми же выборками, что питают рабочий
 * стол, но В `<Suspense>`: оболочка рендерится ПОСЛЕ данных страницы, и
 * ожидание счётчиков здесь же добавляло бы к каждому экрану ещё один поход в
 * базу перед первым байтом. Страница уходит сразу, числа доезжают потоком;
 * отказ базы гасит число, а не экран.
 */
export async function PanelShell({
  actor,
  current,
  live = true,
  children,
}: {
  actor: PanelActor;
  /** Адрес текущего раздела — для подсветки пункта меню. */
  current?: string;
  /** Живое обновление раз в 25 с. Выключается там, где оно мешает. */
  live?: boolean;
  children: React.ReactNode;
}) {
  const groups = groupedSectionsFor(actor.role);
  const jar = await cookies();
  const collapsed = isSidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const closedGroups = readClosedGroups(jar.get(NAV_CLOSED_COOKIE)?.value);
  const theme = readTheme(jar.get(THEME_COOKIE)?.value);
  const density = readDensity(jar.get(DENSITY_COOKIE)?.value);

  const brand = (
    <Link href="/admin" className="panel-brand">
      <span className="panel-brand__mark" aria-hidden>
        О
      </span>
      <span className="panel-brand__word">Оплатишка</span>
    </Link>
  );

  return (
    <>
      {live ? <LiveRefresh /> : null}

      <PanelLayout
        collapsedInitial={collapsed}
        brand={brand}
        nav={groups.map((group) => (
          <PanelNavGroup
            key={group.group}
            group={group.group}
            title={group.title}
            closedInitial={closedGroups.has(group.group)}
            badge={
              <Suspense fallback={null}>
                <NavGroupBadge role={actor.role} sections={group.sections} />
              </Suspense>
            }
          >
            {group.sections.map((section) => (
              <Link
                key={section.href}
                href={section.href}
                className="panel-sidebar__link"
                aria-current={current === section.href ? 'page' : undefined}
                // Название есть у КАЖДОГО пункта: в свёрнутом меню наведение —
                // единственный способ убедиться, какой раздел под значком.
                // Недоступный раздел помечен, чтобы менеджер не тратил время
                // на клик и не думал, что раздел сломан.
                title={section.allowed ? section.title : `${section.title} · ${FORBIDDEN_TEXT.menuHint}`}
              >
                <PanelIcon name={section.capability} className="panel-sidebar__icon" />
                <span className="panel-sidebar__label">
                  {section.title}
                  {section.allowed ? null : ' ·'}
                </span>
                {isMenuBadgeSection(section.capability) ? (
                  <Suspense fallback={null}>
                    <NavBadge role={actor.role} section={section.capability} />
                  </Suspense>
                ) : null}
              </Link>
            ))}
          </PanelNavGroup>
        ))}
        actor={
          <div className="panel-actor">
            <PanelViewToggles themeInitial={theme} densityInitial={density} />
            <div className="panel-actor__row">
              <span className="panel-actor__name">
                {actor.displayName} · {staffRoleLabel(actor.role)}
              </span>
              <form method="post" action="/api/panel/auth/logout">
                <button type="submit" className="panel-icon-button" title={ACTION_TITLES.logout}>
                  <span className="panel-visually-hidden">{ACTION_TITLES.logout}</span>
                  <PanelIcon name="logout" />
                </button>
              </form>
            </div>
          </div>
        }
      >
        {children}
      </PanelLayout>
    </>
  );
}

/**
 * Счётчик одного пункта. Все пункты зовут один `readMenuCounts` — запрос в
 * памятке общий, так что два бейджа не означают два похода в базу.
 */
async function NavBadge({ role, section }: { role: PanelActor['role']; section: MenuBadgeSection }) {
  const count = menuBadges(role, await readMenuCounts(role))[section];
  if (count === undefined) return null;
  return (
    <span className="panel-nav-badge" aria-label={attentionLabel(count)}>
      {count}
    </span>
  );
}

/**
 * Счётчик всей группы — виден только у СВЁРНУТОЙ (правило в CSS: у раскрытой
 * то же число стояло бы дважды).
 *
 * Свёрнутая группа обязана признаваться, что внутри есть работа: иначе
 * настройка «убрать с глаз редкое» однажды спрячет три неотвеченных обращения.
 * Считается тем же `readMenuCounts` и теми же правилами показа (`menuBadges`
 * молчит про закрытый роли раздел), поэтому число группы не может оказаться
 * больше суммы видимых пунктов.
 */
async function NavGroupBadge({
  role,
  sections,
}: {
  role: PanelActor['role'];
  sections: readonly PanelSectionForRole[];
}) {
  const badges = menuBadges(role, await readMenuCounts(role));
  let total = 0;
  for (const section of sections) {
    if (!isMenuBadgeSection(section.capability)) continue;
    total += badges[section.capability] ?? 0;
  }
  if (total <= 0) return null;
  return (
    <span className="panel-nav-badge panel-nav-badge--group" aria-label={attentionLabel(total)}>
      {total}
    </span>
  );
}

/**
 * Заглушка раздела владельца для менеджера. Именно объясняющая, а не пустой
 * экран и не ошибка: человек должен понять, что раздел существует и почему он
 * закрыт, а не решить, что панель сломалась.
 */
export function PanelForbidden({ title }: { title: string }) {
  return (
    <div className="panel-card">
      <h1 className="panel-title">{title}</h1>
      <p className="panel-muted">
        {FORBIDDEN_TEXT.title} {FORBIDDEN_TEXT.hint}
      </p>
    </div>
  );
}
