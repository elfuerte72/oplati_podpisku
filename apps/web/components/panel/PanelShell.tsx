import Link from 'next/link';
import { Suspense } from 'react';

import { isMenuBadgeSection, menuBadges, type MenuBadgeSection } from '@/lib/panel/desk';
import { ACTION_TITLES, FORBIDDEN_TEXT, attentionLabel } from '@/lib/panel/labels';
import type { PanelActor } from '@/lib/panel/login';
import { readMenuCounts } from '@/lib/panel/menu-counts';
import { sectionsFor } from '@/lib/panel/permissions';
import { staffRoleLabel } from '@/lib/panel/roles';

import { LiveRefresh } from './LiveRefresh';

/**
 * Оболочка панели: меню со счётчиками работы, «кто вошёл», выход.
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
export function PanelShell({
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
  const sections = sectionsFor(actor.role);

  return (
    <div className="panel-shell">
      {live ? <LiveRefresh /> : null}

      <header className="panel-header">
        <Link href="/admin" className="panel-brand">
          Оплатишка
        </Link>

        <nav className="panel-nav">
          {sections.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              aria-current={current === section.href ? 'page' : undefined}
              // Пункт виден всем; недоступный помечен, чтобы менеджер не тратил
              // время на клик и не думал, что раздел сломан.
              title={section.allowed ? undefined : 'Раздел владельца'}
            >
              {section.title}
              {section.allowed ? null : ' ·'}
              {isMenuBadgeSection(section.capability) ? (
                <Suspense fallback={null}>
                  <NavBadge role={actor.role} section={section.capability} />
                </Suspense>
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="panel-actor">
          <span>
            {actor.displayName} · {staffRoleLabel(actor.role)}
          </span>
          <form method="post" action="/api/panel/auth/logout">
            <button type="submit" className="panel-button">
              {ACTION_TITLES.logout}
            </button>
          </form>
        </div>
      </header>

      <main className="panel-main">
        <div className="panel-content">{children}</div>
      </main>
    </div>
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
