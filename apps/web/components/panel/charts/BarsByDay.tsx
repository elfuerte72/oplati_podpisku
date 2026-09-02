import { axisTicks, labelledIndexes, shortDay } from './scale';

/**
 * Столбцы по дням — серверный SVG без клиентского JS и без зависимостей.
 *
 * Панель — плотные SSR-таблицы; тянуть chart-библиотеку ради трёх форм нечем
 * оправдать (спека панели v2, ветка A). Формы — по правилам dataviz: столбец
 * не толще 24px, скруглён только сверху и растёт от единственной базовой
 * линии, между соседями зазор в цвет подложки, сетка — одна тонкая линия,
 * подписи — тихим текстовым цветом, а не цветом данных.
 *
 * Числа дублируются текстом: `<title>` на каждом столбце (нативная подсказка
 * при наведении) и строка-итог под графиком — график читается и без картинки,
 * и копируется как текст.
 */

export type DayPoint = { day: string; value: number };

const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 8 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** Столбец со скруглённым верхом и плоским основанием на базовой линии. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  if (h <= 0) return '';
  const bottom = y + h;
  return [
    `M${x} ${bottom}`,
    `V${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `H${x + w - r}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `V${bottom}`,
    'Z',
  ].join(' ');
}

export function BarsByDay({
  points,
  format,
  title,
}: {
  points: readonly DayPoint[];
  /** Формат значения для подсказок и итога (деньги форматирует панель). */
  format: (value: number) => string;
  title: string;
}) {
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotH;
  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = axisTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const slot = points.length > 0 ? plotW / points.length : plotW;
  const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const labelled = new Set(labelledIndexes(points.length));
  const total = points.reduce((sum, p) => sum + p.value, 0);

  return (
    <figure className="panel-chart">
      <svg
        className="panel-chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        {ticks.map((tick) => {
          const y = baseline - (tick / top) * plotH;
          return (
            <line
              key={tick}
              className="panel-chart__grid"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y}
              y2={y}
            />
          );
        })}
        {points.map((p, i) => {
          const h = top > 0 ? (p.value / top) * plotH : 0;
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const y = baseline - h;
          return (
            <g key={p.day}>
              {h > 0 ? (
                <path className="panel-chart__bar" d={barPath(x, y, barW, h)}>
                  <title>{`${shortDay(p.day)} — ${format(p.value)}`}</title>
                </path>
              ) : null}
              {labelled.has(i) ? (
                <text
                  className="panel-chart__label"
                  x={PAD.left + i * slot + slot / 2}
                  y={HEIGHT - 6}
                  textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                >
                  {shortDay(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="panel-chart__caption">
        <span>{title}</span>
        <span className="panel-chart__caption-value">
          Итого {format(total)} · максимум за день {format(max)}
        </span>
      </figcaption>
    </figure>
  );
}
