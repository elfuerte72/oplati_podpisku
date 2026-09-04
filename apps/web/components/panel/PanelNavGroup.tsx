'use client';

import { useId, useState } from 'react';

import { ACTION_TITLES } from '@/lib/panel/labels';
import {
  NAV_CLOSED_COOKIE,
  closedGroupsCookieValue,
  pickCookie,
  prefCookieString,
  readClosedGroups,
} from '@/lib/panel/prefs';

import { PanelIcon } from './PanelIcon';

/**
 * Группа пунктов меню, которую можно свернуть.
 *
 * Зачем: у менеджера половина разделов закрыта, у владельца — одиннадцать
 * пунктов, из которых в обычный день нужны три. Свернуть «Управление» значит
 * убрать с глаз то, куда заходят раз в месяц, не пряча этого от себя навсегда.
 *
 * ⚠️ Клиентский здесь только тумблер. Сами пункты и счётчики приходят готовой
 * серверной разметкой через `children`/`badge`: иначе счётчики (асинхронные
 * серверные компоненты в `<Suspense>`) пришлось бы тянуть в браузер.
 *
 * Состояние пишется В ОДНУ cookie на все группы, поэтому перед записью она
 * перечитывается: соседняя группа могла закрыться после рендера, и запись из
 * пропсов затёрла бы её.
 */
export function PanelNavGroup({
  group,
  title,
  closedInitial,
  badge,
  children,
}: {
  group: string;
  /** `null` — группа без заголовка (её нельзя свернуть, и сворачивать нечего). */
  title: string | null;
  closedInitial: boolean;
  /** Счётчик работы всей группы — виден, когда группа свёрнута. */
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [closed, setClosed] = useState(closedInitial);
  const itemsId = useId();

  function toggle() {
    const next = !closed;
    setClosed(next);
    const current = new Set(readClosedGroups(pickCookie(document.cookie, NAV_CLOSED_COOKIE)));
    if (next) current.add(group);
    else current.delete(group);
    document.cookie = prefCookieString(NAV_CLOSED_COOKIE, closedGroupsCookieValue(current));
  }

  return (
    <div className="panel-sidebar__group" data-closed={title && closed ? '' : undefined}>
      {title ? (
        <button
          type="button"
          className="panel-sidebar__group-title"
          onClick={toggle}
          aria-expanded={!closed}
          aria-controls={itemsId}
          title={closed ? ACTION_TITLES.expandGroup : ACTION_TITLES.collapseGroup}
        >
          <PanelIcon name="chevronDown" className="panel-sidebar__group-chevron" />
          <span className="panel-sidebar__group-name">{title}</span>
          {/*
           * Счётчик группы показывается ТОЛЬКО у свёрнутой (правило в CSS):
           * иначе одно и то же число стояло бы дважды — у группы и у пункта.
           * Свёрнутая группа без него прятала бы работу, а меню обязано
           * отвечать «что сделать сейчас» в любом своём состоянии.
           */}
          {badge}
        </button>
      ) : null}
      <div className="panel-sidebar__group-items" id={itemsId}>
        {children}
      </div>
    </div>
  );
}
