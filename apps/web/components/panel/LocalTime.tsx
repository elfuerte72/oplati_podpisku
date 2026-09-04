'use client';

import { useSyncExternalStore } from 'react';

import { formatAge } from '@/lib/panel/format';

/**
 * Время в часовом поясе БРАУЗЕРА (спека §3.4).
 *
 * Форматируем на клиенте, а не на сервере: контейнер живёт в UTC, и серверная
 * строка показывала бы менеджеру чужое время. До гидратации выводим ISO — он не
 * врёт и не прыгает в вёрстке.
 *
 * Механика — `useSyncExternalStore`, а не `useState` + `useEffect`: последнее
 * означает установку состояния прямо в эффекте, то есть лишний каскад
 * перерисовок на каждой ячейке плотной таблицы.
 */

const noopSubscribe = () => () => {};

/** Отрисовка уже на клиенте? На сервере и в первом проходе — `false`. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Номер текущей минуты — «часы», по которым пересчитывается возраст. Снимок
 * бакетится по минутам, иначе `useSyncExternalStore` считал бы состояние
 * изменившимся на каждом рендере.
 */
function subscribeMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

/**
 * ⚠️ Серверный снимок — НЕ `null`, а та же текущая минута.
 *
 * Возраст не зависит от часового пояса: это разность двух моментов, и сервер
 * считает её ровно так же, как браузер (страницы панели рендерятся на каждый
 * запрос, кэша тут нет). Прежний `null` рисовал до гидратации прочерк — и на
 * экране обращений это читалось как «— назад», а свежее обращение после
 * гидратации превращалось в «только что назад».
 *
 * Расхождение в минуту между серверным рендером и гидратацией снимает
 * `suppressHydrationWarning` на самом элементе.
 */
function useMinuteTick(): number {
  const nowMinute = () => Math.floor(Date.now() / 60_000);
  return useSyncExternalStore(subscribeMinute, nowMinute, nowMinute);
}

export function LocalTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();

  // До гидратации показываем ИСХОДНОЕ время с пометкой UTC. Без пометки оно
  // неотличимо от локального, а разница с Москвой — три часа: менеджер решил
  // бы, что заказ создан позже, чем на самом деле.
  const text = hydrated
    ? new Date(iso).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : `${iso.slice(0, 16).replace('T', ' ')} UTC`;

  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}

/**
 * Возраст записи. Считается от часов ЧИТАТЕЛЯ и обновляется раз в минуту:
 * «5 мин» не должно висеть полчаса на живом экране.
 *
 * ⚠️ Слово «назад» здесь НЕ дописывается, и экраны его тоже не дописывают:
 * «5 мин» рядом со временем создания читается однозначно, а «только что назад»
 * (единственный экран, который дописывал) читалось как опечатка.
 */
export function LocalAge({ iso }: { iso: string }) {
  const minute = useMinuteTick();

  return (
    <span title={iso} suppressHydrationWarning>
      {formatAge(new Date(iso), new Date(minute * 60_000))}
    </span>
  );
}
