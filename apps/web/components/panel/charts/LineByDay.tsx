import { axisTicks, labelledIndexes, shortDay } from './scale';
import type { DayPoint } from './BarsByDay';

/**
 * Линия по дням — серверный SVG (см. `BarsByDay`, те же правила dataviz):
 * линия 2px со скруглёнными стыками, маркер только на последней точке (с
 * кольцом в цвет подложки), подпись значения — у конца линии, сетка тихая.
 *
 * Одна серия — легенды нет: что нарисовано, говорит заголовок.
 */

const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 12, right: 56, bottom: 22, left: 8 };

export function LineByDay({
  points,
  format,
  title,
}: {
  points: readonly DayPoint[];
  format: (value: number) => string;
  title: string;
}) {
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotH;
  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = axisTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
  const xAt = (i: number) => PAD.left + (points.length > 1 ? i * stepX : plotW / 2);
  const yAt = (value: number) => baseline - (value / top) * plotH;
  const coords = points.map((p, i) => [xAt(i), yAt(p.value)] as const);
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const lastXY = coords[coords.length - 1];
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
        {ticks.map((tick) => (
          <line
            key={tick}
            className="panel-chart__grid"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={yAt(tick)}
            y2={yAt(tick)}
          />
        ))}
        {points.length > 1 ? <path className="panel-chart__line" d={path} /> : null}
        {points.map((p, i) => {
          const x = coords[i]?.[0] ?? PAD.left;
          return (
            <g key={p.day}>
              {/* Невидимая широкая цель для нативной подсказки: точка сама по
                  себе слишком мала, чтобы в неё попасть курсором. */}
              <rect
                className="panel-chart__hit"
                x={Math.max(PAD.left, x - (stepX || plotW) / 2)}
                y={PAD.top}
                width={Math.min(stepX || plotW, WIDTH - PAD.right - Math.max(PAD.left, x - (stepX || plotW) / 2))}
                height={plotH}
              >
                <title>{`${shortDay(p.day)} — ${format(p.value)}`}</title>
              </rect>
              {labelled.has(i) ? (
                <text
                  className="panel-chart__label"
                  x={x}
                  y={HEIGHT - 6}
                  textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                >
                  {shortDay(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
        {last && lastXY ? (
          <g>
            <circle className="panel-chart__dot-ring" cx={lastXY[0]} cy={lastXY[1]} r={6} />
            <circle className="panel-chart__dot" cx={lastXY[0]} cy={lastXY[1]} r={4} />
            <text
              className="panel-chart__value"
              x={lastXY[0] + 10}
              y={lastXY[1] + 4}
              textAnchor="start"
            >
              {format(last.value)}
            </text>
          </g>
        ) : null}
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
