import { cookies } from 'next/headers';
import Link from 'next/link';
import { Suspense } from 'react';

import { isMenuBadgeSection, menuBadges, type MenuBadgeSection } from '@/lib/panel/desk';
import { ACTION_TITLES, FORBIDDEN_TEXT, attentionLabel } from '@/lib/panel/labels';
import type { PanelActor } from '@/lib/panel/login';
import { readMenuCounts } from '@/lib/panel/menu-counts';
import { groupedSectionsFor } from '@/lib/panel/permissions';
import { staffRoleLabel } from '@/lib/panel/roles';
import { SIDEBAR_COOKIE, isSidebarCollapsed } from '@/lib/panel/sidebar';

import { LiveRefresh } from './LiveRefresh';
import { PanelLayout } from './PanelLayout';

/**
 * Оболочка панели: боковое меню со счётчиками работы, «кто вошёл», выход.
 *
 * Меню вертикальное и сгруппированное (панель v3): десять пунктов в одну
 * строку занимали всю ширину экрана, а каждый новый раздел эту строку ломал.
 * Группа отвечает на вопрос «что это за пункты», а не просто режет список.
 *
 * ⚠️ Разделы владельца показываются менеджеру ТОЖЕ (спека §4.3) — с пометкой.
 * Скрывать пункт значило бы полагаться на то, что менеджер не наберёт адрес
 * руками; настоящая защита живёт в операции (`guardPanelOperation`).
 *
 * Счётчики в меню (редизайн, тикет 02) считаются на сервере теми же
 * выборками, что питают рабочий стол, но В `<Suspense>`: оболочка рендерится
 * ПОСЛЕ данных страницы, и ожидание счётчиков здесь же добавляло бы к каждому
 * экрану ещё один поход в базу перед первым байтом. Теперь страница уходит
 * сразу, числа доезжают потоком; отказ базы гасит число, а не экран.
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
  const collapsed = isSidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);

  const brand = (
    <Link href="/admin" className="panel-brand">
      Оплатишка
    </Link>
  );

  return (
    <>
      {live ? <LiveRefresh /> : null}

      <PanelLayout
        collapsedInitial={collapsed}
        brand={brand}
        nav={groups.map((group) => (
          <div key={group.group} className="panel-sidebar__group">
            <p className="panel-sidebar__group-title">{group.title}</p>
            {group.sections.map((section) => (
              <Link
                key={section.href}
                href={section.href}
                className="panel-sidebar__link"
                aria-current={current === section.href ? 'page' : undefined}
                // ДВЕ буквы названия — то, что остаётся от пункта в свёрнутом
                // меню. Иконок у панели нет, а одной буквы мало: на «П»
                // начинаются четыре раздела (проверка платежей, поддержка,
                // партнёры, персонал), и меню читалось бы ребусом.
                data-initial={section.title.slice(0, 2)}
                // Название есть у КАЖДОГО пункта: в свёрнутом меню наведение —
                // единственный способ убедиться, что «Пр» это проверка
                // платежей, а не персонал. Недоступный раздел помечен, чтобы
                // менеджер не тратил время на клик и не думал, что раздел
                // сломан.
                title={section.allowed ? section.title : `${section.title} · ${FORBIDDEN_TEXT.menuHint}`}
              >
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
          </div>
        ))}
        actor={
          <div className="panel-actor">
            <span className="panel-actor__name">
              {actor.displayName} · {staffRoleLabel(actor.role)}
            </span>
            <form method="post" action="/api/panel/auth/logout">
              <button type="submit" className="panel-button panel-button--squeezable">
                {/* В свёрнутом меню от кнопки остаётся знак: слово «Выйти» в
                    колонку 56px не помещается и уезжает под таблицу. Текст при
                    этом никуда не девается — он читается голосом экрана. */}
                <span className="panel-button__label">{ACTION_TITLES.logout}</span>
                <span className="panel-button__sign" aria-hidden>
                  ⎋
                </span>
              </button>
            </form>
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
