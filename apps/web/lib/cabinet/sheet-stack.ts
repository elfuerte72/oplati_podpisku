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
