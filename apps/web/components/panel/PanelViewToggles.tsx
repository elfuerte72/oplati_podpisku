'use client';

import { useRef, useState } from 'react';

import { ACTION_TITLES, THEME_STATE_TITLES } from '@/lib/panel/labels';
import {
  DENSITY_COOKIE,
  THEME_COOKIE,
  nextTheme,
  prefCookieString,
  type PanelDensity,
  type PanelTheme,
} from '@/lib/panel/prefs';

import { PanelIcon, type PanelIconName } from './PanelIcon';

/** Значок ТЕКУЩЕЙ темы и подсказка о том, что включит следующее нажатие. */
const THEME_ICON: Record<PanelTheme, PanelIconName> = {
  system: 'themeSystem',
  light: 'sun',
  dark: 'moon',
};

const THEME_ACTION: Record<PanelTheme, string> = {
  system: ACTION_TITLES.themeSystem,
  light: ACTION_TITLES.themeLight,
  dark: ACTION_TITLES.themeDark,
};

/**
 * Тумблеры вида: тема и плотность строк.
 *
 * Обе настройки применяются К DOM СРАЗУ и параллельно пишутся в cookie: cookie
 * решает, каким придёт СЛЕДУЮЩИЙ серверный рендер, но сама по себе картинку не
 * меняет — без правки атрибута тема переключалась бы только на следующем
 * переходе, и тумблер выглядел бы сломанным.
 *
 * Атрибут ставится на ближайший `.panel`, а не на `<html>`, и зовётся
 * `data-panel-theme`, а не `data-theme`: панель делит приложение с витриной
 * сайта, у которой своя тема, свой тумблер и нескоупленный селектор
 * `[data-theme="light"]` в `globals.css` — общее имя перекрашивало бы одну из
 * них по вкусу другой.
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

  /**
   * Корень панели. Тумблер рендерится только внутри `.panel` (`app/admin/
   * layout.tsx`), поэтому его отсутствие — ошибка программы: бросаем, а не
   * молчим. Тихий `if (el)` оставил бы cookie записанной и значок
   * перевёрнутым при неизменившемся экране — и никто бы об этом не узнал.
   */
  function panelRoot(): HTMLElement {
    const el = root.current?.closest<HTMLElement>('.panel');
    if (!el) throw new Error('PanelViewToggles rendered outside .panel');
    return el;
  }

  function switchTheme() {
    const next = nextTheme(theme);
    setTheme(next);
    panelRoot().dataset.panelTheme = next;
    document.cookie = prefCookieString(THEME_COOKIE, next);
  }

  function switchDensity() {
    const next: PanelDensity = density === 'cosy' ? 'compact' : 'cosy';
    setDensity(next);
    panelRoot().dataset.density = next;
    document.cookie = prefCookieString(DENSITY_COOKIE, next);
  }

  // Подсказка называет то, что ВКЛЮЧИТСЯ по нажатию: кнопка — это действие.
  // А вот ТЕКУЩЕЕ состояние темы подписано словом прямо на кнопке: у трёх
  // состояний третье («как в системе») значком не выразить, да и «солнце»
  // одинаково законно читается и как «сейчас светло», и как «сделать светло».
  const themeAction = THEME_ACTION[nextTheme(theme)];
  const densityAction = density === 'cosy' ? ACTION_TITLES.densityCompact : ACTION_TITLES.densityCosy;

  return (
    <div className="panel-view-toggles" ref={root}>
      <span className="panel-view-toggles__title">{ACTION_TITLES.viewSettings}</span>
      <button
        type="button"
        className="panel-view-toggles__theme"
        onClick={switchTheme}
        title={themeAction}
      >
        <span className="panel-visually-hidden">{themeAction}</span>
        <PanelIcon name={THEME_ICON[theme]} />
        <span className="panel-view-toggles__state" aria-hidden>
          {THEME_STATE_TITLES[theme]}
        </span>
      </button>
      <button type="button" className="panel-icon-button" onClick={switchDensity} title={densityAction}>
        <span className="panel-visually-hidden">{densityAction}</span>
        <PanelIcon name={density === 'cosy' ? 'rowsCompact' : 'rowsCosy'} />
      </button>
    </div>
  );
}
