import Link from 'next/link';

import type { PanelActor } from '@/lib/panel/login';
import { sectionsFor } from '@/lib/panel/permissions';
import { staffRoleLabel } from '@/lib/panel/roles';

import { LiveRefresh } from './LiveRefresh';

/**
 * Оболочка панели: меню, «кто вошёл», выход.
 *
 * ⚠️ Разделы владельца показываются менеджеру ТОЖЕ (спека §4.3) — с пометкой.
 * Скрывать пункт значило бы полагаться на то, что менеджер не наберёт адрес
 * руками; настоящая защита живёт в операции (`guardPanelOperation`).
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
            </Link>
          ))}
        </nav>

        <div className="panel-actor">
          <span>
            {actor.displayName} · {staffRoleLabel(actor.role)}
          </span>
          <form method="post" action="/api/panel/auth/logout">
            <button type="submit" className="panel-button">
              Выйти
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
 * Заглушка раздела владельца для менеджера. Именно объясняющая, а не пустой
 * экран и не ошибка: человек должен понять, что раздел существует и почему он
 * закрыт, а не решить, что панель сломалась.
 */
export function PanelForbidden({ title }: { title: string }) {
  return (
    <div className="panel-card">
      <h1 className="panel-title">{title}</h1>
      <p className="panel-muted">
        Раздел доступен только владельцу. Если он нужен тебе по работе — попроси владельца
        открыть доступ.
      </p>
    </div>
  );
}
