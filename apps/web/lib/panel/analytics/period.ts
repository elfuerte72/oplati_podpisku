import { z } from 'zod';

/**
 * Период разделов панели с данными за окно («Аналитика», «Обратная связь»).
 *
 * Живёт В АДРЕСЕ (`?period=7|30|90`), как фильтры заказов: ссылку на нужный
 * срез можно переслать коллеге. Разбор — граница (инвариант 5): чужое
 * значение откатывается к 30 дням молча, а не роняет страницу.
 *
 * Границы считаются по календарным дням UTC — так же, как группируют по дням
 * выборки в `packages/db` (`to_char(… AT TIME ZONE 'UTC')`); на экране время
 * показывается по часовому поясу браузера, как везде в панели (`LocalTime`).
 *
 * Модуль читают серверные страницы и тесты: ни Next, ни env, ни БД.
 */

export const ANALYTICS_PERIODS = [7, 30, 90] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = 30;

const periodSchema = z.enum(['7', '30', '90']);

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** `?period=` из адреса; мусор и пустота → период по умолчанию. */
export function parsePeriod(
  params: Record<string, string | string[] | undefined>,
): AnalyticsPeriod {
  const parsed = periodSchema.safeParse(firstValue(params.period));
  return parsed.success ? (Number(parsed.data) as AnalyticsPeriod) : DEFAULT_ANALYTICS_PERIOD;
}

export type PeriodBounds = {
  /** Полночь UTC первого дня окна (включительно). */
  since: Date;
  /** Полночь UTC завтрашнего дня — правая граница, исключена. Сегодня входит целиком. */
  until: Date;
  days: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Окно из `days` календарных UTC-дней, заканчивающееся сегодняшним днём. */
export function periodBounds(days: AnalyticsPeriod, now: Date): PeriodBounds {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    since: new Date(todayStart - (days - 1) * DAY_MS),
    until: new Date(todayStart + DAY_MS),
    days,
  };
}

/** Адрес того же раздела с другим периодом — для переключателя без клиентского JS. */
export function periodHref(path: string, period: AnalyticsPeriod): string {
  return `${path}?period=${period}`;
}
