import { describe, expect, it } from 'vitest';

import { effectiveSupportMode } from './support-mode';

const NOW = new Date('2026-09-17T12:00:00Z');
const past = new Date(NOW.getTime() - 60_000);
const future = new Date(NOW.getTime() + 60_000);

/**
 * Эффективный режим на экранах поддержки (crm-serious-fixes, тикет 03, SUP-13).
 *
 * Сессия помощника гаснет лениво: в БД у истёкшей по-прежнему `ai`, и панель
 * бессрочно показывала «Помощник» там, где клиентом не занимается никто.
 */
describe('effectiveSupportMode', () => {
  it('помощник с истёкшим сроком показывается свободным разговором', () => {
    expect(effectiveSupportMode('ai', past, NOW)).toBe('idle');
  });

  it('живая сессия помощника остаётся помощником', () => {
    expect(effectiveSupportMode('ai', future, NOW)).toBe('ai');
  });

  it('помощник без срока не гаснет', () => {
    expect(effectiveSupportMode('ai', null, NOW)).toBe('ai');
  });

  it('оператор лениво не гаснет — его закрывает крон, а не экран', () => {
    expect(effectiveSupportMode('operator', past, NOW)).toBe('operator');
  });

  it('свободный разговор остаётся свободным', () => {
    expect(effectiveSupportMode('idle', null, NOW)).toBe('idle');
  });

  it('незнакомое значение из базы показывается как есть — это сигнал разъезда', () => {
    expect(effectiveSupportMode('paused', past, NOW)).toBe('paused');
  });
});
