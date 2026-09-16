import 'server-only';

import { ANALYTICS_EVENTS, ANALYTICS_MILESTONES } from '@oplati/types';

import { formatKopecks, formatUsdCents } from './format';
import { ACTIVITY_CHANNEL_LABELS, ACTIVITY_TEXT } from './labels';

/**
 * Лента действий клиента в его карточке: подписи и детали строки.
 *
 * Названия событий берутся ИЗ словаря аналитики (`@oplati/types`) — того же,
 * что подписывает воронку в «Отчётах» и словарь `analytics_event_types` в
 * базе. Второго набора подписей событий панель не заводит (ANALYTICS_TEXT
 * говорит то же про воронку): подпись, разошедшаяся с отчётом, путала бы
 * человека, который смотрит на клиента и на воронку по очереди.
 *
 * ⚠️ Серверный модуль (`server-only` бросит при импорте из клиентского
 * компонента): словарь аналитики тянет `zod`, в клиентский бандл панели ему
 * нельзя. Страница карточки — серверный компонент, ей можно.
 */

const EVENT_TITLES: Record<string, string> = Object.fromEntries([
  ...Object.entries(ANALYTICS_EVENTS).map(([name, spec]) => [name, spec.title]),
  ...Object.entries(ANALYTICS_MILESTONES).map(([name, spec]) => [name, spec.title]),
]);

/** Подпись события. Неизвестное имя показывается как есть — это сигнал, а не прочерк. */
export function activityTitle(name: string): string {
  return EVENT_TITLES[name] ?? name;
}

/**
 * Канал события; у вех из денежных таблиц (`derived`) канала нет. Значение
 * приходит из базы строкой, поэтому проверяется вхождение в словарь, а не
 * доверяется тип.
 */
export function activityChannelLabel(channel: string): string | null {
  return Object.hasOwn(ACTIVITY_CHANNEL_LABELS, channel)
    ? ACTIVITY_CHANNEL_LABELS[channel as keyof typeof ACTIVITY_CHANNEL_LABELS]
    : null;
}

/**
 * Что показать рядом с событием: сервис, тариф, страница, источник, сумма.
 * Ключи перечислены явно и в порядке важности: props — свободный словарь,
 * и печатать его целиком значило бы показывать UTM-метки и хвосты адресов
 * там, где человек ищет «что он нажал».
 */
export function activityDetails(props: Record<string, unknown> | null): string | null {
  if (!props) return null;
  const parts: string[] = [];
  const text = (key: string): string | null => {
    const value = props[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const number = (key: string): number | null => {
    const value = props[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  const slug = text('slug');
  if (slug) parts.push(slug);
  const plan = text('plan');
  if (plan) parts.push(plan);
  const path = text('path');
  if (path) parts.push(path);
  const src = text('src') ?? text('utm_source');
  if (src) parts.push(`${ACTIVITY_TEXT.from} ${src}`);
  const kopecks = number('amount_kopecks');
  if (kopecks !== null) {
    parts.push(formatKopecks(kopecks));
  } else {
    const cents = number('amount_usd_cents');
    if (cents !== null) parts.push(formatUsdCents(cents));
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
