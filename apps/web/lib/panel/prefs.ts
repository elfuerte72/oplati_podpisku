/**
 * Настройки вида панели: тема, плотность строк, свёрнутые группы меню.
 *
 * ⚠️ Все три живут в COOKIE и читаются СЕРВЕРОМ — по той же причине, что и
 * сворачивание меню (`sidebar.ts`): `PanelShell` рендерит каждая страница, а
 * не layout, поэтому React-состояние теряется на каждом переходе, а чтение в
 * браузере после гидратации даёт прыжок первого кадра — светлая тема моргала
 * бы тёмной на каждом клике.
 *
 * Это настройки ВИДА, а не секреты: cookie доступна скрипту (её же пишут
 * тумблеры) и не участвует ни в одной проверке доступа. Поэтому неизвестное
 * значение не ошибка, а повод взять умолчание.
 */

/**
 * Тема панели — ТРИ состояния, и умолчание из них «как в системе» (решение
 * владельца 04.09, пересмотр решения от 03.09 «тема только тёмная»).
 *
 * Рекомендации Apple просят следовать теме операционной системы и не заводить
 * собственную настройку внешнего вида. Тумблер остаётся для тех, кому нужно
 * иначе: уже сделанный выбор лежит в cookie и продолжает действовать — новое
 * умолчание касается только тех, кто тумблер не трогал.
 *
 * Порядок в списке — порядок обхода тумблером.
 */
export const PANEL_THEMES = ['system', 'light', 'dark'] as const;
export type PanelTheme = (typeof PANEL_THEMES)[number];

/**
 * Плотность строк. `cosy` — умолчание: строка с воздухом читается без
 * привыкания, а `compact` включает тот, кто целый день смотрит в таблицу.
 */
export const PANEL_DENSITIES = ['cosy', 'compact'] as const;
export type PanelDensity = (typeof PANEL_DENSITIES)[number];

export const THEME_COOKIE = 'panel_theme';
export const DENSITY_COOKIE = 'panel_density';
export const NAV_CLOSED_COOKIE = 'panel_nav_closed';

/** Год: настройку вида незачем переспрашивать каждую сессию. */
export const PREF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function readTheme(value: string | undefined): PanelTheme {
  return (PANEL_THEMES as readonly string[]).includes(value ?? '')
    ? (value as PanelTheme)
    : 'system';
}

/** Что включится по следующему нажатию тумблера: система → светлая → тёмная. */
export function nextTheme(current: PanelTheme): PanelTheme {
  const at = PANEL_THEMES.indexOf(current);
  return PANEL_THEMES[(at + 1) % PANEL_THEMES.length] ?? 'system';
}

export function readDensity(value: string | undefined): PanelDensity {
  return (PANEL_DENSITIES as readonly string[]).includes(value ?? '') ? (value as PanelDensity) : 'cosy';
}

/**
 * Свёрнутые группы меню — список ключей через запятую.
 *
 * Хранится именно то, что СВЁРНУТО, а не то, что раскрыто: новая группа
 * появляется раскрытой у всех, у кого cookie написана прежней версией панели.
 * Хранили бы раскрытые — новый раздел прятался бы ровно у тех, кто настроил
 * меню под себя, и выглядел бы пропавшим.
 *
 * Мусор игнорируется поэлементно: чужая строка в cookie не должна складывать
 * меню целиком.
 */
export function readClosedGroups(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      // Ключи групп — латиница из `PANEL_SECTION_GROUPS`; всё прочее пришло не
      // от наших тумблеров, и место ему не в состоянии меню.
      .filter((part) => /^[a-z]{1,32}$/.test(part)),
  );
}

/**
 * Строка `document.cookie` для записи настройки из браузера.
 *
 * Собирается здесь, а не в компоненте: cookie с другим `Path` не перезаписывает
 * прежнюю, а ложится второй — и настройка начинает зависеть от того, с какого
 * экрана её переключили. `Secure` — для единообразия с cookie сессии (панель
 * живёт по HTTPS, localhost браузеры считают защищённым).
 */
export function prefCookieString(name: string, value: string): string {
  const maxAge = value === '' ? 0 : PREF_COOKIE_MAX_AGE_SECONDS;
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}

/** Значение cookie свёрнутых групп из набора. Пустой набор гасит cookie. */
export function closedGroupsCookieValue(groups: Iterable<string>): string {
  return [...groups].join(',');
}

/**
 * Значение одной cookie из строки `document.cookie`.
 *
 * Нужно тумблеру свёрнутых групп: он знает только свою группу, а пишется
 * ОДНА cookie со всем списком — значит, перед записью её надо прочитать. Взять
 * состояние из пропсов нельзя: соседняя группа могла закрыться после рендера,
 * и запись затёрла бы её.
 *
 * Функция чистая (принимает строку, а не лезет в `document`), поэтому её видно
 * тестам и она не мешает серверному импорту модуля.
 */
export function pickCookie(all: string, name: string): string | undefined {
  for (const part of all.split(';')) {
    const raw = part.trim();
    if (!raw.startsWith(`${name}=`)) continue;
    return raw.slice(name.length + 1);
  }
  return undefined;
}
