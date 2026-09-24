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

/** Длительность доезда ряда на полный кадр (в CSS живёт то же число). */
export const SETTLE_MS = 250;

/**
 * Самый короткий доезд. Быстрее ряд не едет даже после резкого броска: движение
 * короче восьми кадров читается как скачок, а не как перелистывание.
 */
export const SETTLE_MIN_MS = 130;

/**
 * Скорость броска, px/мс (400 точек в секунду). Быстрый короткий бросок —
 * то, как листают в нативных приложениях: требовать от него 28% ширины значит
 * откатывать ряд назад под пальцем, который явно просил перелистнуть.
 */
export const FLICK_VELOCITY = 0.4;

/** Минимальный путь броска: дрожь пальца на месте броском не считается. */
export const FLICK_MIN_PX = 24;

/**
 * Окно, по которому считается скорость в момент отпускания. Скорость всего
 * жеста не годится: палец мог долго вести ряд, а в конце остановиться — такой
 * жест не бросок.
 */
export const VELOCITY_WINDOW_MS = 100;

/**
 * Во сколько раз доезд длиннее «ровного» хода с той же скоростью. Кривая
 * `ease-out` стартует примерно в 1,7 раза быстрее своей средней скорости, и
 * множитель подгоняет первый кадр доезда под скорость пальца: ряд не
 * дёргается вперёд и не проседает в момент отпускания.
 */
const EASE_OUT_START_FACTOR = 1.6;

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
 * Индекс вкладки после отпускания. Смена — только к существующему соседу: за
 * порогом `COMMIT_RATIO` ширины или броском (`FLICK_VELOCITY` в ту же сторону).
 * Бросок в обратную сторону — «передумал»: ряд возвращается, даже если палец
 * успел пройти порог. Ширина 0 (кадр ещё не измерен) вкладку не меняет.
 *
 * `velocity` — px/мс со знаком (минус — влево), по `releaseVelocity`.
 */
export function resolveSwipe(dx: number, width: number, index: number, count: number, velocity = 0): number {
  if (width <= 0) return index;
  if (!hasNeighbour(dx, index, count)) return index;
  const next = index + (dx < 0 ? 1 : -1);
  const flicking = Math.abs(velocity) >= FLICK_VELOCITY;
  if (flicking && Math.sign(velocity) !== Math.sign(dx)) return index;
  if (flicking && Math.abs(dx) >= FLICK_MIN_PX) return next;
  if (Math.abs(dx) <= width * COMMIT_RATIO) return index;
  return next;
}

/** Точка пути пальца: время события (мс) и координата по горизонтали. */
export type SwipeSample = { t: number; x: number };

/**
 * Скорость пальца в момент отпускания, px/мс со знаком. Считается по последним
 * `VELOCITY_WINDOW_MS`: остановившийся перед отпусканием палец даёт ноль, даже
 * если до этого ряд ехал быстро. Меньше двух точек или нулевое окно — ноль.
 */
export function releaseVelocity(samples: readonly SwipeSample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const recent = samples.filter((s) => last.t - s.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  if (!first || last.t <= first.t) return 0;
  return (last.x - first.x) / (last.t - first.t);
}

/**
 * Длительность доезда ряда после отпускания, мс. Короткий остаток доезжает
 * быстрее полного кадра, бросок — со скоростью пальца (если она выше), но не
 * быстрее `SETTLE_MIN_MS` и не дольше `SETTLE_MS`. Фиксированные 250 мс на
 * любой остаток давали ряд, который после резкого броска вдруг замедляется, —
 * это и читается как «подвисание».
 *
 * `velocity` учитывается, только если палец шёл к цели (`towardTarget`): при
 * откате назад скорость броска относится к другому направлению.
 */
export function settleDurationMs(remainingPx: number, width: number, velocity: number, towardTarget: boolean): number {
  if (width <= 0 || remainingPx <= 0) return SETTLE_MIN_MS;
  const fraction = Math.min(1, remainingPx / width);
  let ms = SETTLE_MIN_MS + (SETTLE_MS - SETTLE_MIN_MS) * fraction;
  const speed = Math.abs(velocity);
  if (towardTarget && speed > 0) {
    ms = Math.min(ms, (EASE_OUT_START_FACTOR * remainingPx) / speed);
  }
  return Math.round(Math.min(SETTLE_MS, Math.max(SETTLE_MIN_MS, ms)));
}

/** Начато ли касание в защитной полосе у левого края (жест там — Telegram'а). */
export function startsInEdgeGuard(x: number): boolean {
  return x < EDGE_GUARD_PX;
}
