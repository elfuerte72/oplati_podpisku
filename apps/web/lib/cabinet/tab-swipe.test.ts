import { describe, expect, it } from 'vitest';

import {
  AXIS_LOCK_PX,
  CABINET_TABS,
  COMMIT_RATIO,
  EDGE_GUARD_PX,
  OVERSCROLL_DAMPING,
  dragOffset,
  lockAxis,
  resolveSwipe,
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
