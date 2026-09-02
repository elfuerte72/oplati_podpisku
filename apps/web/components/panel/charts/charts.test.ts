import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BarsByDay } from './BarsByDay';
import { HBars } from './HBars';
import { LineByDay } from './LineByDay';
import { axisTicks, labelledIndexes, niceCeil, shortDay } from './scale';

/**
 * Графики раздела «Аналитика» (панель v2, тикет 03): серверный SVG без
 * клиентского JS. Проверяем то, что ломается молча: число столбцов на длинном
 * ряду, нулевой ряд (масштаб не делится на ноль), дублирование значений
 * текстом и прочерк вместо конверсии, которую считать нечем.
 */

function days(count: number, value: (i: number) => number) {
  const out: { day: string; value: number }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
    out.push({ day: d.toISOString().slice(0, 10), value: value(i) });
  }
  return out;
}

const rub = (v: number) => `${v} ₽`;

describe('scale', () => {
  it('верх оси — круглое число не меньше максимума; ноль и мусор → 1', () => {
    expect(niceCeil(3417)).toBe(5000);
    expect(niceCeil(1000)).toBe(1000);
    expect(niceCeil(21)).toBe(25);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(axisTicks(90)).toEqual([0, 50, 100]);
  });

  it('подписываются первый, средний и последний дни', () => {
    expect(labelledIndexes(90)).toEqual([0, 44, 89]);
    expect(labelledIndexes(1)).toEqual([0]);
    expect(labelledIndexes(0)).toEqual([]);
    expect(shortDay('2026-03-01')).toBe('01.03');
  });
});

describe('BarsByDay', () => {
  it('ряд из 90 точек даёт 90 столбцов, каждый с подсказкой-значением', () => {
    const html = renderToStaticMarkup(
      createElement(BarsByDay, { points: days(90, (i) => 100 + i), format: rub, title: 'Выручка' }),
    );
    expect(html.match(/class="panel-chart__bar"/g)?.length).toBe(90);
    expect(html).toContain('<title>01.01 — 100 ₽</title>');
    // Итог продублирован текстом под графиком.
    expect(html).toContain('Итого');
    expect(html).toContain('aria-label="Выручка"');
  });

  it('нули не ломают масштаб: столбцов нет, сетка и подписи есть, NaN в разметке нет', () => {
    const html = renderToStaticMarkup(
      createElement(BarsByDay, { points: days(7, () => 0), format: rub, title: 'Выручка' }),
    );
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('panel-chart__bar');
    expect(html).toContain('panel-chart__grid');
    expect(html).toContain('01.01');
  });

  it('пустой ряд рендерится без ошибок', () => {
    const html = renderToStaticMarkup(
      createElement(BarsByDay, { points: [], format: rub, title: 'Выручка' }),
    );
    expect(html).not.toContain('NaN');
  });
});

describe('LineByDay', () => {
  it('рисует одну линию и маркер на последней точке со значением', () => {
    const html = renderToStaticMarkup(
      createElement(LineByDay, { points: days(30, (i) => i % 5), format: String, title: 'Заказы' }),
    );
    expect(html.match(/class="panel-chart__line"/g)?.length).toBe(1);
    expect(html).toContain('panel-chart__dot-ring');
    expect(html).not.toContain('NaN');
    // Последняя точка: 29 % 5 = 4.
    expect(html).toContain('>4</text>');
  });

  it('одна точка — без линии, но с маркером; нули — без NaN', () => {
    const one = renderToStaticMarkup(
      createElement(LineByDay, { points: days(1, () => 3), format: String, title: 'Заказы' }),
    );
    expect(one).not.toContain('panel-chart__line');
    expect(one).toContain('panel-chart__dot');
    const zeros = renderToStaticMarkup(
      createElement(LineByDay, { points: days(7, () => 0), format: String, title: 'Заказы' }),
    );
    expect(zeros).not.toContain('NaN');
  });
});

describe('HBars', () => {
  it('длина полосы — доля от максимума; конверсия null показывается прочерком', () => {
    const html = renderToStaticMarkup(
      createElement(HBars, {
        title: 'Воронка',
        rows: [
          { key: 'a', label: 'Зашёл', value: 10, valueText: '10', note: null },
          { key: 'b', label: 'Открыл', value: 5, valueText: '5', note: '50%' },
        ],
      }),
    );
    expect(html).toContain('width:100.0%');
    expect(html).toContain('width:50.0%');
    expect(html).toContain('<span class="panel-hbars__note">—</span>');
    expect(html).toContain('<span class="panel-hbars__note">50%</span>');
  });

  it('все нули — полосы нулевой длины, без NaN', () => {
    const html = renderToStaticMarkup(
      createElement(HBars, {
        title: 'Топ',
        rows: [{ key: 'a', label: 'Netflix', value: 0, valueText: '0' }],
      }),
    );
    expect(html).toContain('width:0.0%');
    expect(html).not.toContain('NaN');
    // Без `note` пометка не рендерится вовсе — прочерк там не нужен.
    expect(html).not.toContain('panel-hbars__note');
  });
});
