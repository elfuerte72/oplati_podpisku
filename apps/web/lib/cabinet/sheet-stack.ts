/**
 * Счёт открытых листов Mini App (трек miniapp-tabs, тикет 03).
 *
 * Системная кнопка «Назад» Telegram одна на всё приложение, а листы могут
 * лежать друг на друге. Поэтому счёт общий: кнопка видна, пока открыт хоть
 * один лист, нажатие закрывает только ВЕРХНИЙ, а прячет кнопку последний
 * уходящий — иначе на Android системный жест «назад» под ещё открытым листом
 * закрывал бы весь Mini App вместе с набранным.
 */
export type SheetStack = {
  /** Лист открылся; возвращает его глубину (1 — нижний). */
  push: () => number;
  /** Лист закрылся. */
  pop: () => void;
  /** Лежит ли лист этой глубины сверху — только он отвечает на «Назад». */
  isTop: (depth: number) => boolean;
  count: () => number;
  backButtonVisible: () => boolean;
};

/** Сколько надо утянуть лист вниз, чтобы отпускание его закрыло. */
export const DRAG_CLOSE_PX = 96;
/** Скорость броска (px/мс), которой хватает, чтобы закрыть не дотянув. */
export const FLICK_PX_PER_MS = 0.5;
/**
 * Короче этого бросок не считается: дрожь пальца, коснувшегося полоски, иначе
 * закрывала бы лист с набранной почтой одним быстрым сдвигом на пару пикселей.
 */
export const FLICK_MIN_PX = 20;

/**
 * Закрыть ли лист, когда палец отпустили (образец — nemo `app/ui/sheet.tsx`):
 * дотянули за порог — да; не дотянули, но бросили быстро — тоже да, короткий
 * резкий жест тоже значит «закрой».
 */
export function shouldCloseOnRelease(offsetPx: number, elapsedMs: number): boolean {
  if (offsetPx > DRAG_CLOSE_PX) return true;
  return offsetPx > FLICK_MIN_PX && offsetPx / Math.max(1, elapsedMs) > FLICK_PX_PER_MS;
}

export function createSheetStack(): SheetStack {
  let open = 0;
  return {
    push: () => {
      open += 1;
      return open;
    },
    pop: () => {
      // Двойной размонтаж (StrictMode в разработке) не должен уводить счёт в
      // минус: следующий лист тогда считал бы себя «не верхним» навсегда.
      open = Math.max(0, open - 1);
    },
    isTop: (depth) => depth === open,
    count: () => open,
    backButtonVisible: () => open > 0,
  };
}
