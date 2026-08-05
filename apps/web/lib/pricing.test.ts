import { describe, expect, it } from 'vitest';

import { roundUpToWholeRubles } from './pricing';

describe('roundUpToWholeRubles', () => {
  it('срезает копейки вверх до целого рубля', () => {
    expect(roundUpToWholeRubles(86_778)).toBe(86_800); // 867,78 ₽ → 868 ₽
    expect(roundUpToWholeRubles(216_944)).toBe(217_000); // 2169,44 ₽ → 2170 ₽
  });

  it('целые рубли не трогает (повторное применение ничего не меняет)', () => {
    expect(roundUpToWholeRubles(210_100)).toBe(210_100);
    expect(roundUpToWholeRubles(roundUpToWholeRubles(86_778))).toBe(86_800);
  });

  it('одна копейка сверх рубля уже поднимает цену — округление в нашу сторону', () => {
    expect(roundUpToWholeRubles(86_701)).toBe(86_800);
  });

  it('надбавка за карту $4: 320,48 ₽ → 321 ₽', () => {
    const result = roundUpToWholeRubles(Math.round(400 * 80.12));
    expect(result).toBe(32_100);
    expect(Number.isInteger(result)).toBe(true);
  });

  // Регресс на float-хвост: 400 центов × 80 ₽ — ровно 320 ₽, и лишнего рубля
  // сверху быть не должно, каким бы шумом ни пришло произведение.
  it('ровная сумма не поднимается на рубль из-за хвоста умножения', () => {
    expect(roundUpToWholeRubles(Math.round(400 * 80))).toBe(32_000);
  });

  it('ноль остаётся нулём (нет активной надбавки за карту)', () => {
    expect(roundUpToWholeRubles(0)).toBe(0);
  });
});
