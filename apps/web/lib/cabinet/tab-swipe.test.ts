import { describe, expect, it } from 'vitest';

import {
  AXIS_LOCK_PX,
  CABINET_TABS,
  COMMIT_RATIO,
  EDGE_GUARD_PX,
  FLICK_MIN_PX,
  FLICK_VELOCITY,
  OVERSCROLL_DAMPING,
  SETTLE_MIN_MS,
  SETTLE_MS,
  VELOCITY_WINDOW_MS,
  dragOffset,
  lockAxis,
  releaseVelocity,
  resolveSwipe,
  settleDurationMs,
  startsInEdgeGuard,
} from './tab-swipe.ts';

/**
 * Свайп между вкладками Mini App (тикет 02). Жест делят три претендента:
 * вертикальная прокрутка вкладки, системный жест Telegram от левого края и
 * наш перенос ряда. Ошибка в любую сторону видна клиенту сразу — либо ряд
 * дёргается при прокрутке, либо приложение закрывается посреди свайпа.
 */

const WIDTH = 400;

describe('порядок вкладок', () => {
  it('Оплата, Карта, Профиль — он же порядок под пальцем', () => {
    expect(CABINET_TABS).toEqual(['pay', 'card', 'profile']);
  });
});

describe('lockAxis', () => {
  it('до порога ось не решена — жест ничей', () => {
    expect(lockAxis(AXIS_LOCK_PX - 1, 0)).toBeNull();
    expect(lockAxis(0, AXIS_LOCK_PX - 1)).toBeNull();
    expect(lockAxis(-(AXIS_LOCK_PX - 1), AXIS_LOCK_PX - 1)).toBeNull();
  });

  it('горизонталь', () => {
    expect(lockAxis(AXIS_LOCK_PX, 2)).toBe('x');
    expect(lockAxis(-30, 5)).toBe('x');
  });

  it('вертикаль — прокрутка вкладки остаётся браузеру', () => {
    expect(lockAxis(2, AXIS_LOCK_PX)).toBe('y');
    expect(lockAxis(4, -30)).toBe('y');
  });

  it('диагональ с перевесом вниз — вертикаль, ряд не дёргается', () => {
    expect(lockAxis(11, 12)).toBe('y');
  });

  it('ровная диагональ отдаётся прокрутке, а не переносу', () => {
    expect(lockAxis(15, 15)).toBe('y');
  });
});

describe('dragOffset', () => {
  it('в середине ряда ряд идёт за пальцем один к одному', () => {
    expect(dragOffset(-120, 1, 3)).toBe(-120);
    expect(dragOffset(90, 1, 3)).toBe(90);
  });

  it('с первой вкладки вправо — вязко: соседа слева нет', () => {
    expect(dragOffset(80, 0, 3)).toBe(80 / OVERSCROLL_DAMPING);
  });

  it('с последней вкладки влево — вязко: соседа справа нет', () => {
    expect(dragOffset(-80, 2, 3)).toBe(-80 / OVERSCROLL_DAMPING);
  });

  it('с первой вкладки влево — к соседу, без вязкости', () => {
    expect(dragOffset(-80, 0, 3)).toBe(-80);
  });
});

describe('resolveSwipe', () => {
  it('ровно на пороге 28% ширины вкладка ещё не меняется', () => {
    expect(resolveSwipe(-WIDTH * COMMIT_RATIO, WIDTH, 0, 3)).toBe(0);
  });

  it('за порогом влево — следующая вкладка', () => {
    expect(resolveSwipe(-(WIDTH * COMMIT_RATIO + 1), WIDTH, 0, 3)).toBe(1);
  });

  it('за порогом вправо — предыдущая вкладка', () => {
    expect(resolveSwipe(WIDTH * COMMIT_RATIO + 1, WIDTH, 2, 3)).toBe(1);
  });

  it('ниже порога — откат на место', () => {
    expect(resolveSwipe(-50, WIDTH, 1, 3)).toBe(1);
    expect(resolveSwipe(50, WIDTH, 1, 3)).toBe(1);
  });

  it('с первой вкладки вправо вкладка не меняется даже при длинном жесте', () => {
    expect(resolveSwipe(WIDTH, WIDTH, 0, 3)).toBe(0);
  });

  it('с последней вкладки влево вкладка не меняется даже при длинном жесте', () => {
    expect(resolveSwipe(-WIDTH, WIDTH, 2, 3)).toBe(2);
  });

  it('нулевая ширина (кадр ещё не измерен) не меняет вкладку', () => {
    expect(resolveSwipe(-10, 0, 1, 3)).toBe(1);
  });
});

describe('resolveSwipe — бросок', () => {
  it('быстрый короткий бросок влево листает, хотя порог 28% не пройден', () => {
    expect(resolveSwipe(-FLICK_MIN_PX, WIDTH, 0, 3, -FLICK_VELOCITY)).toBe(1);
  });

  it('быстрый короткий бросок вправо листает назад', () => {
    expect(resolveSwipe(60, WIDTH, 2, 3, 0.9)).toBe(1);
  });

  it('медленный короткий жест — не бросок: откат на место', () => {
    expect(resolveSwipe(-60, WIDTH, 0, 3, -(FLICK_VELOCITY - 0.01))).toBe(0);
  });

  it('дрожь пальца быстрым движением на месте броском не считается', () => {
    expect(resolveSwipe(-(FLICK_MIN_PX - 1), WIDTH, 0, 3, -2)).toBe(0);
  });

  it('бросок в обратную сторону — «передумал»: ряд возвращается даже за порогом', () => {
    expect(resolveSwipe(-(WIDTH * 0.6), WIDTH, 0, 3, 0.8)).toBe(0);
  });

  it('бросок к краю, где соседа нет, вкладку не меняет', () => {
    expect(resolveSwipe(80, WIDTH, 0, 3, 1.5)).toBe(0);
    expect(resolveSwipe(-80, WIDTH, 2, 3, -1.5)).toBe(2);
  });

  it('без скорости (прежний вызов) решает только порог', () => {
    expect(resolveSwipe(-(WIDTH * COMMIT_RATIO + 1), WIDTH, 0, 3)).toBe(1);
    expect(resolveSwipe(-60, WIDTH, 0, 3)).toBe(0);
  });
});

describe('releaseVelocity', () => {
  it('скорость — по последнему окну, со знаком направления', () => {
    const samples = [
      { t: 0, x: 300 },
      { t: 16, x: 290 },
      { t: 32, x: 270 },
      { t: 48, x: 240 },
    ];
    expect(releaseVelocity(samples)).toBeCloseTo(-60 / 48);
  });

  it('палец остановился перед отпусканием — скорость ноль, а не средняя за жест', () => {
    const samples = [
      { t: 0, x: 300 },
      { t: 50, x: 150 },
      { t: 50 + VELOCITY_WINDOW_MS + 1, x: 150 },
      { t: 50 + VELOCITY_WINDOW_MS + 60, x: 150 },
    ];
    expect(releaseVelocity(samples)).toBe(0);
  });

  it('меньше двух точек или нулевое время — ноль', () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([{ t: 10, x: 5 }])).toBe(0);
    expect(releaseVelocity([{ t: 10, x: 5 }, { t: 10, x: 50 }])).toBe(0);
  });
});

describe('settleDurationMs', () => {
  it('полный кадр без скорости — стандартные 250 мс', () => {
    expect(settleDurationMs(WIDTH, WIDTH, 0, true)).toBe(SETTLE_MS);
  });

  it('короткий остаток доезжает быстрее полного кадра', () => {
    const short = settleDurationMs(WIDTH * 0.2, WIDTH, 0, true);
    expect(short).toBeLessThan(SETTLE_MS);
    expect(short).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
  });

  it('резкий бросок — ряд едет со скоростью пальца, но не быстрее нижней границы', () => {
    expect(settleDurationMs(WIDTH * 0.7, WIDTH, -5, true)).toBe(SETTLE_MIN_MS);
    const medium = settleDurationMs(WIDTH * 0.7, WIDTH, -2.5, true);
    expect(medium).toBeGreaterThan(SETTLE_MIN_MS);
    expect(medium).toBeLessThan(settleDurationMs(WIDTH * 0.7, WIDTH, 0, true));
  });

  it('скорость в сторону от цели (откат) длительность не укорачивает', () => {
    expect(settleDurationMs(WIDTH * 0.5, WIDTH, 3, false)).toBe(settleDurationMs(WIDTH * 0.5, WIDTH, 0, true));
  });

  it('никогда не выходит за [SETTLE_MIN_MS, SETTLE_MS]', () => {
    for (const rem of [0, 1, 50, WIDTH, WIDTH * 3]) {
      for (const v of [0, 0.1, 1, 10]) {
        const ms = settleDurationMs(rem, WIDTH, v, true);
        expect(ms).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
        expect(ms).toBeLessThanOrEqual(SETTLE_MS);
      }
    }
  });
});

describe('startsInEdgeGuard', () => {
  it('касание в полосе у левого края — системный жест Telegram, не наш', () => {
    expect(startsInEdgeGuard(0)).toBe(true);
    expect(startsInEdgeGuard(EDGE_GUARD_PX - 1)).toBe(true);
  });

  it('за полосой — жест наш', () => {
    expect(startsInEdgeGuard(EDGE_GUARD_PX)).toBe(false);
    expect(startsInEdgeGuard(200)).toBe(false);
  });
});
