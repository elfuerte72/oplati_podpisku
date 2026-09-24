import { describe, expect, it } from 'vitest';

import { DRAG_CLOSE_PX, FLICK_MIN_PX, createSheetStack, shouldCloseOnRelease } from './sheet-stack.ts';

/**
 * Стек листов Mini App (тикет 03). Системная «Назад» Telegram одна на всё
 * приложение: она видна, пока открыт хоть один лист, и закрывает ВЕРХНИЙ.
 * Ошибка в счёте видна сразу: либо кнопка висит без листа и закрывает Mini App,
 * либо пропадает под ещё открытым листом.
 */

describe('createSheetStack', () => {
  it('пустой стек — «Назад» не нужна', () => {
    const stack = createSheetStack();
    expect(stack.count()).toBe(0);
    expect(stack.backButtonVisible()).toBe(false);
  });

  it('открытый лист показывает «Назад» и считается верхним', () => {
    const stack = createSheetStack();
    const depth = stack.push();
    expect(depth).toBe(1);
    expect(stack.backButtonVisible()).toBe(true);
    expect(stack.isTop(depth)).toBe(true);
  });

  it('вложенный лист верхний, нижний — нет: «Назад» закрывает один', () => {
    const stack = createSheetStack();
    const lower = stack.push();
    const upper = stack.push();
    expect(stack.isTop(upper)).toBe(true);
    expect(stack.isTop(lower)).toBe(false);
    stack.pop();
    expect(stack.isTop(lower)).toBe(true);
    expect(stack.backButtonVisible()).toBe(true);
  });

  it('последний закрытый прячет «Назад»', () => {
    const stack = createSheetStack();
    stack.push();
    stack.pop();
    expect(stack.backButtonVisible()).toBe(false);
  });

  it('лишний pop не уводит счёт в минус (двойной размонтаж StrictMode)', () => {
    const stack = createSheetStack();
    stack.pop();
    expect(stack.count()).toBe(0);
    stack.push();
    expect(stack.count()).toBe(1);
  });
});

/**
 * Потяг листа вниз (тикет 03): в листе заказа набирают почту и промокод, и лист,
 * закрывшийся от дрожи пальца, теряет введённое.
 */
describe('shouldCloseOnRelease — потяг листа вниз', () => {
  it('дотянули за порог — лист закрывается', () => {
    expect(shouldCloseOnRelease(DRAG_CLOSE_PX + 1, 1000)).toBe(true);
  });

  it('медленно и не дотянули — лист возвращается', () => {
    expect(shouldCloseOnRelease(DRAG_CLOSE_PX - 1, 1000)).toBe(false);
  });

  it('короткий резкий бросок закрывает, не дотянув до порога', () => {
    expect(shouldCloseOnRelease(40, 50)).toBe(true);
  });

  it('дрожь пальца даже быстрым движением лист не закрывает', () => {
    expect(shouldCloseOnRelease(FLICK_MIN_PX, 5)).toBe(false);
    expect(shouldCloseOnRelease(15, 10)).toBe(false);
  });

  it('нулевое время жеста не делит на ноль', () => {
    expect(shouldCloseOnRelease(30, 0)).toBe(true);
    expect(shouldCloseOnRelease(0, 0)).toBe(false);
  });
});
