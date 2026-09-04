import { describe, expect, it } from 'vitest';

import { SECTION_TITLES } from '@/lib/panel/labels';

import { PANEL_ICON_NAMES } from './PanelIcon';

/**
 * Полнота набора значков.
 *
 * Формально её держит тип (`Record<SectionKey, ReactElement>`), но значок —
 * единственное имя раздела в свёрнутом меню: раздел без него становится там
 * пустой полосой, на которую человек не нажмёт. Проверка рантаймом стоит
 * копейки и переживает ослабление типа.
 */
describe('набор значков панели', () => {
  it('у каждого раздела меню есть свой значок', () => {
    for (const key of Object.keys(SECTION_TITLES)) {
      expect(PANEL_ICON_NAMES).toContain(key);
    }
  });

  it('значки оболочки на месте: меню, поиск, тумблеры вида, выход', () => {
    // Эти нажимаются без подписи рядом, и пропажа любого оставила бы пустую
    // кнопку — визуально исправную и бессмысленную.
    for (const name of ['menu', 'search', 'collapse', 'expand', 'chevronDown', 'logout', 'sun', 'moon']) {
      expect(PANEL_ICON_NAMES).toContain(name);
    }
  });
});
