'use client';

import { useRef, useState } from 'react';

import { ACTION_TITLES } from '@/lib/panel/labels';
import {
  DENSITY_COOKIE,
  THEME_COOKIE,
  prefCookieString,
  type PanelDensity,
  type PanelTheme,
} from '@/lib/panel/prefs';

import { PanelIcon } from './PanelIcon';

/**
 * Тумблеры вида: тема и плотность строк.
 *
 * Обе настройки применяются К DOM СРАЗУ и параллельно пишутся в cookie: cookie
 * решает, каким придёт СЛЕДУЮЩИЙ серверный рендер, но сама по себе картинку не
 * меняет — без правки атрибута тема переключалась бы только на следующем
 * переходе, и тумблер выглядел бы сломанным.
 *
 * Атрибут ставится на ближайший `.panel`, а не на `<html>`: панель делит
 * приложение с витриной сайта, у которой своя тема и свой тумблер (общий
 * атрибут перекрашивал бы одну из них по вкусу другой).
 */
export function PanelViewToggles({
  themeInitial,
  densityInitial,
}: {
  themeInitial: PanelTheme;
  densityInitial: PanelDensity;
}) {
  const [theme, setTheme] = useState(themeInitial);
  const [density, setDensity] = useState(densityInitial);
  const root = useRef<HTMLDivElement>(null);

  function panelRoot(): HTMLElement | null {
    return root.current?.closest('.panel') ?? null;
  }

  function switchTheme() {
    const next: PanelTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    const el = panelRoot();
    if (el) el.dataset.theme = next;
    document.cookie = prefCookieString(THEME_COOKIE, next);
  }

  function switchDensity() {
    const next: PanelDensity = density === 'cosy' ? 'compact' : 'cosy';
    setDensity(next);
    const el = panelRoot();
    if (el) el.dataset.density = next;
    document.cookie = prefCookieString(DENSITY_COOKIE, next);
  }

  // Значок и подпись называют то, что ВКЛЮЧИТСЯ по нажатию, а не текущее
  // состояние: кнопка — это действие. Текущее состояние видно по самому экрану.
  const themeAction = theme === 'dark' ? ACTION_TITLES.themeLight : ACTION_TITLES.themeDark;
  const densityAction = density === 'cosy' ? ACTION_TITLES.densityCompact : ACTION_TITLES.densityCosy;

  return (
    <div className="panel-view-toggles" ref={root}>
      <span className="panel-view-toggles__title">{ACTION_TITLES.viewSettings}</span>
      <button type="button" className="panel-icon-button" onClick={switchTheme} title={themeAction}>
        <span className="panel-visually-hidden">{themeAction}</span>
        <PanelIcon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <button type="button" className="panel-icon-button" onClick={switchDensity} title={densityAction}>
        <span className="panel-visually-hidden">{densityAction}</span>
        <PanelIcon name={density === 'cosy' ? 'rowsCompact' : 'rowsCosy'} />
      </button>
    </div>
  );
}
