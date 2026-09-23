/**
 * Свайп между вкладками Mini App (трек miniapp-tabs, тикет 02) — чистая часть
 * без DOM. Обработчики касаний живут в оболочке (`CabinetClient`), здесь —
 * только решения: чей жест, куда едет ряд и какая вкладка останется после
 * отпускания. Значения констант и их обоснования взяты из образца —
 * `nemo_project/apps/miniapp/app/client-app.tsx`, где они проверены живьём.
 */

/**
 * Вкладки в ряд. Порядок — это и порядок под пальцем: «Карта» стоит рядом с
 * «Оплатой», потому что она её продолжение (после оплаты приложение само
 * переводит на неё), «Профиль» с краю — туда заходят реже всего.
 */
export const CABINET_TABS = ['pay', 'card', 'profile'] as const;
export type CabinetTab = (typeof CABINET_TABS)[number];

/**
 * Сколько надо увести палец, чтобы стало ясно, ведут его вбок или вниз. До
 * этого порога жест не присвоен никому: решить по первому же пикселю значит
 * отобрать прокрутку у того, кто начал её чуть наискось.
 */
export const AXIS_LOCK_PX = 10;

/**
 * Какую долю ширины надо пройти, чтобы вкладка сменилась. Меньше четверти — и
 * вкладка меняется от неловкого движения; больше половины — и донести палец до
 * конца тяжелее, чем нажать кнопку панели.
 */
export const COMMIT_RATIO = 0.28;

/**
 * Полоса у левого края, где жест не начинается. Telegram на iOS забирает свайп
 * от края себе («назад»/закрыть) — приложение закрылось бы посреди переноса, и
 * это выглядело бы поломкой, а не системным жестом.
 */
export const EDGE_GUARD_PX = 22;

/**
 * Вязкость переноса за крайней вкладкой. Соседа там нет, и ряд должен упереться
 * — но не встать намертво: неподвижность читается как зависшее приложение, а
 * замедлившийся ряд — как его край.
 */
export const OVERSCROLL_DAMPING = 4;

/** Длительность доезда ряда после отпускания (в CSS живёт то же число). */
export const SETTLE_MS = 250;

/**
 * Чей жест. `null` — пока смещение не вышло за порог ни по одной оси.
 *
 * Ровная диагональ отдаётся прокрутке: вертикальный жест вкладки — основной,
 * а ряд, дёрнувшийся под пальцем, листающим список, раздражает сильнее, чем
 * свайп, который пришлось повторить ровнее.
 */
export function lockAxis(dx: number, dy: number): 'x' | 'y' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < AXIS_LOCK_PX && ay < AXIS_LOCK_PX) return null;
  return ax > ay ? 'x' : 'y';
}

/** Есть ли сосед в сторону движения пальца (влево — следующая вкладка). */
function hasNeighbour(dx: number, index: number, count: number): boolean {
  const target = index + (dx < 0 ? 1 : -1);
  return target >= 0 && target < count;
}

/** Смещение ряда под пальцем: к соседу — один к одному, за край — вязко. */
export function dragOffset(dx: number, index: number, count: number): number {
  return hasNeighbour(dx, index, count) ? dx : dx / OVERSCROLL_DAMPING;
}

/**
 * Индекс вкладки после отпускания. Смена — только к существующему соседу и
 * только за порогом `COMMIT_RATIO` ширины; иначе ряд возвращается на место.
 * Ширина 0 (кадр ещё не измерен) вкладку не меняет.
 */
export function resolveSwipe(dx: number, width: number, index: number, count: number): number {
  if (width <= 0) return index;
  if (!hasNeighbour(dx, index, count)) return index;
  if (Math.abs(dx) <= width * COMMIT_RATIO) return index;
  return index + (dx < 0 ? 1 : -1);
}

/** Начато ли касание в защитной полосе у левого края (жест там — Telegram'а). */
export function startsInEdgeGuard(x: number): boolean {
  return x < EDGE_GUARD_PX;
}
