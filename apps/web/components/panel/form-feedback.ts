'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Два общих приёма форм панели (вариант A дизайн-аудита, тикет 05).
 *
 * До него успех сообщался ЧЕТЫРЬМЯ способами: зелёная пилюля вместо кнопки,
 * серая строка под формой, молчаливая очистка поля и просто ничего. Два
 * действия из четырёх — ответ клиенту и отметка о ручной выдаче — не сообщали
 * ничего вовсе: менеджер узнавал об отправке по тому, что текст пропал из
 * поля, и отличить «отправилось» от «форму сбросило» было нечем.
 */

/** Сколько живёт строка успеха. Три секунды — успел прочитать, не мозолит глаз. */
const FLASH_MS = 3000;

/**
 * Тихое сообщение об успехе: показать и через три секунды убрать.
 *
 * ⚠️ Только для УСПЕХА. Ошибка так не гасится: её показывают, пока человек не
 * повторит действие, — иначе отказ можно не заметить и решить, что получилось.
 */
export function useFlash(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Компонент могли снять с экрана раньше срока (строка таблицы перерисовалась
  // после `router.refresh()`): таймер обязан уйти вместе с ним.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = useCallback((next: string) => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), FLASH_MS);
  }, []);

  return [text, flash];
}

/** Сколько взведённая кнопка ждёт второго нажатия, прежде чем передумать. */
const ARMED_MS = 5000;

export type TwoStep = {
  /** Кнопка взведена: подпись сменилась на подтверждающую. */
  armed: boolean;
  /**
   * Нажатие. `false` — это было ПЕРВОЕ нажатие, действие выполнять рано.
   * `true` — подтверждение получено, можно делать.
   */
  press: () => boolean;
  /** Снять взвод: после успеха, после отказа и при уходе с формы. */
  reset: () => void;
};

/**
 * Двухшаговая кнопка. Приём взят из решений по выплатам, где он уже жил, и
 * стал общим: всё, что уходит клиенту наружу или необратимо, просит второе
 * нажатие.
 *
 * Модальное окно не вводится намеренно: рекомендации просят его для
 * критичного с потерей данных, а двухшаговая кнопка не закрывает соседние
 * строки таблицы и работает с клавиатуры.
 *
 * ⚠️ Взвод сам спадает через пять секунд. Иначе кнопка, взведённая и забытая,
 * выстреливает от случайного клика через полчаса — а это отправка сообщения
 * живому человеку.
 */
export function useTwoStep(): TwoStep {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reset = useCallback(() => {
    clear();
    setArmed(false);
  }, [clear]);

  const press = useCallback(() => {
    if (armed) {
      clear();
      setArmed(false);
      return true;
    }
    setArmed(true);
    clear();
    timer.current = setTimeout(() => setArmed(false), ARMED_MS);
    return false;
  }, [armed, clear]);

  return { armed, press, reset };
}
