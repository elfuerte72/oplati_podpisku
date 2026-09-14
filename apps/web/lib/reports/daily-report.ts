import type {
  AnalyticsRange,
  DailyAudience,
  DailyOrderFlow,
  DailyPaidOrder,
  DailyPromoDiscounts,
  DailySupport,
  RevenueSummary,
} from '@oplati/db';

import { formatOpsMessage, panelUrl } from '../alerts/format.ts';
import { formatKopecks, formatUsdCents } from '../panel/format.ts';
import { ORDER_STATUS_LABELS } from '../panel/labels.ts';

/**
 * Дневной отчёт в тему «Отчёты» ops-группы: окно и текст. Чистые функции без
 * env и БД — данные собирает `lib/jobs/daily-report.ts`.
 *
 * Окно — сутки, закончившиеся в `REPORT_HOUR_MSK` по Москве (решение владельца
 * 2026-09-14: отчёт в 18:00, а не после полуночи). Именно скользящие сутки
 * «вчера 18:00 — сегодня 18:00», а не «сегодня с полуночи до 18:00»: иначе вечер
 * с 18:00 до полуночи не попадал бы ни в один отчёт, а оплаты вечером — обычное дело.
 *
 * Время московское: владелец и клиенты живут по Москве. Смещение
 * фиксированное (+03:00): переход на летнее время в России отменён в 2014 году.
 *
 * Текст — plain text, как у всех уведомлений персоналу (`alerts/format.ts`):
 * имена клиентов приходят из Telegram, и экранировать их под разметку в одной
 * точке значило бы однажды забыть в другой.
 */

const MSK_OFFSET = '+03:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const TIME_ZONE = 'Europe/Moscow';

/**
 * Час по Москве, которым заканчивается окно отчёта. Зеркало (инвариант 10):
 * время запуска крона в `infra/crontab.example` (`0 15 * * *` — 15:00 UTC).
 * Переносишь отчёт — правь обе стороны, иначе крон пришлёт неполные сутки.
 */
export const REPORT_HOUR_MSK = 18;

/** Лимит длины сообщения Telegram. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

function mskDate(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Дата (`YYYY-MM-DD` по Москве) окна, закрывшегося последним к моменту `now`:
 * в 18:00 и позже — сегодняшнее, раньше — вчерашнее.
 */
export function lastClosedReportDay(now: Date): string {
  const mskHour = new Date(now.getTime() + MSK_OFFSET_MS).getUTCHours();
  const today = mskDate(now);
  return mskHour >= REPORT_HOUR_MSK ? today : mskDate(new Date(now.getTime() - DAY_MS));
}

/** Окно отчёта за день `D`: `[D-1 18:00, D 18:00)` по Москве — в UTC, ISO-строками. */
export function reportWindow(day: string): AnalyticsRange {
  const hour = String(REPORT_HOUR_MSK).padStart(2, '0');
  const until = new Date(`${day}T${hour}:00:00${MSK_OFFSET}`);
  return {
    since: new Date(until.getTime() - DAY_MS).toISOString(),
    until: until.toISOString(),
  };
}

export type ReportDayResult =
  | { ok: true; day: string; range: AnalyticsRange; partial: boolean }
  | { ok: false; reason: 'invalid_day' | 'future_day' };

/**
 * День отчёта из параметра запроса. Без параметра — последнее закрытое окно
 * (так зовёт крон). С параметром — ручная переотправка за нужную дату; окно,
 * которое ещё идёт, разрешено и помечается неполным, ещё не начавшееся — нет:
 * отчёт о будущем был бы набором нулей, неотличимым от пустого дня.
 */
export function resolveReportDay(raw: string | null | undefined, now: Date): ReportDayResult {
  const day = raw?.trim() ? raw.trim() : lastClosedReportDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, reason: 'invalid_day' };
  const range = reportWindow(day);
  const until = new Date(range.until);
  // 2026-02-30 разбирается в 2 марта: сверяем, что дата не «переехала».
  if (Number.isNaN(until.getTime()) || mskDate(until) !== day) {
    return { ok: false, reason: 'invalid_day' };
  }
  if (new Date(range.since).getTime() > now.getTime()) return { ok: false, reason: 'future_day' };
  return { ok: true, day, range, partial: until.getTime() > now.getTime() };
}

/** Срез «что ждёт сейчас»: `null` у пункта — прочитать не удалось. */
export type DailyReportNow = {
  pending: { count: number; sumKopecks: number } | null;
  holds: number | null;
  unansweredSupport: number | null;
  vcc: { balanceUsdCents: number; readAt: Date } | null;
};

export type DailyReportData = {
  /** День окна `D`: сутки `[D-1 18:00, D 18:00)` по Москве. */
  day: string;
  /** Окно ещё не закрылось (ручной запуск до 18:00). */
  partial: boolean;
  revenue: RevenueSummary;
  audience: DailyAudience;
  flow: DailyOrderFlow;
  paid: { items: DailyPaidOrder[]; total: number };
  promo: DailyPromoDiscounts;
  support: DailySupport;
  now: DailyReportNow;
};

/** «пн, 14 сентября». */
export function formatReportDate(day: string): string {
  return new Date(`${day}T12:00:00${MSK_OFFSET}`).toLocaleDateString('ru-RU', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
}

/** «13 сентября». */
function formatDayMonth(date: Date): string {
  return date.toLocaleDateString('ru-RU', { timeZone: TIME_ZONE, day: 'numeric', month: 'long' });
}

function formatMskTime(date: Date): string {
  return date.toLocaleTimeString('ru-RU', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
}

/** «С 18:00 13 сентября до 18:00 14 сентября (МСК)». */
export function formatReportPeriod(day: string): string {
  const range = reportWindow(day);
  const since = new Date(range.since);
  const until = new Date(range.until);
  return `С ${formatMskTime(since)} ${formatDayMonth(since)} до ${formatMskTime(until)} ${formatDayMonth(until)} (МСК)`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Кто: `@username`, иначе имя из Telegram — оператор найдёт клиента по номеру заказа. */
function clientLabel(order: DailyPaidOrder): string {
  const username = order.telegramUsername?.trim();
  if (username) return `@${username}`;
  const name = order.displayName?.trim();
  return name ? truncate(name, 24) : 'без имени';
}

function serviceLabel(order: DailyPaidOrder): string {
  if (order.serviceName) {
    return truncate(order.tierName ? `${order.serviceName} ${order.tierName}` : order.serviceName, 36);
  }
  return order.customDescription ? truncate(order.customDescription, 36) : 'сервис не указан';
}

/**
 * Строка оплаты. Статус дописывается, только если заказ НЕ выполнен: список
 * читают ради «всё ли дошло», и десять «Выполнен» подряд утопили бы одну «Ошибку».
 *
 * Окно захватывает две даты, поэтому оплата накануне вечером получает дату
 * («13.09 20:15»), а сегодняшняя — только время: иначе «20:15» над «10:09»
 * читалось бы как сбитая сортировка.
 */
export function paidOrderLine(order: DailyPaidOrder, day: string): string {
  const time = formatMskTime(order.paidAt);
  const when =
    mskDate(order.paidAt) === day
      ? time
      : `${order.paidAt.toLocaleDateString('ru-RU', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' })} ${time}`;
  const parts = [
    when,
    clientLabel(order),
    serviceLabel(order),
    // Сумма — то, что клиент заплатил: она складывается в «Получено денег».
    // Скидка названа рядом, иначе сумма расходилась бы с ценой заказа в панели.
    order.discountKopecks > 0
      ? `${formatKopecks(order.amountKopecks - order.discountKopecks)} (скидка ${formatKopecks(order.discountKopecks)})`
      : formatKopecks(order.amountKopecks),
    order.shortId,
  ];
  if (order.status !== 'completed') {
    const label = (ORDER_STATUS_LABELS as Record<string, string | undefined>)[order.status];
    parts.push(label ?? order.status);
  }
  return parts.join(' · ');
}

function countOrDash(value: number | null): string {
  return value === null ? 'не удалось прочитать' : String(value);
}

function buildBody(data: DailyReportData, paidShown: number, panelHost: string | null | undefined): string {
  const { audience, flow, revenue, paid, support, now } = data;
  const sections: string[] = [];

  sections.push(
    data.partial
      ? `${formatReportPeriod(data.day)}\nСутки ещё не закончились — цифры на момент отправки.`
      : formatReportPeriod(data.day),
  );

  sections.push(
    [
      'Заходили',
      `В бот и кабинет: ${audience.telegramVisitors} чел.`,
      `Нажали /start: ${audience.botStarts} · открыли кабинет: ${audience.cabinetOpens}`,
      `Новых клиентов: ${audience.newTelegramUsers} · по реф-ссылке: ${audience.referralJoins}`,
      `На сайте: ${audience.webVisitors} чел.`,
    ].join('\n'),
  );

  const orders = [
    'Заказы',
    `Оформлено: ${flow.created} · выставлен счёт: ${flow.invoiced}`,
    `Получено денег: ${formatKopecks(revenue.amountKopecks)}`,
    `Покупок: ${revenue.paidOrders}` +
      (revenue.paidOrders > 0 ? ` · средний чек ${formatKopecks(revenue.averageKopecks)}` : ''),
  ];
  if (data.promo.kopecks > 0) {
    orders.push(`Скидки по промокодам: ${formatKopecks(data.promo.kopecks)} (заказов: ${data.promo.orders})`);
  }
  if (revenue.bonusRedeemedKopecks > 0) {
    orders.push(`Оплачено баллами: ${formatKopecks(revenue.bonusRedeemedKopecks)}`);
  }
  orders.push(`Истёк срок: ${flow.expired} · отменили: ${flow.cancelled}`);
  orders.push(`На проверке банка: ${flow.paymentReview} · ошибка: ${flow.failed}`);
  sections.push(orders.join('\n'));

  const payers = ['Кто оплатил'];
  if (paid.total === 0) {
    payers.push('Оплат не было.');
  } else {
    for (const order of paid.items.slice(0, paidShown)) payers.push(paidOrderLine(order, data.day));
    const hidden = paid.total - Math.min(paidShown, paid.items.length);
    if (hidden > 0) payers.push(`…и ещё ${hidden} — список в разделе «Все заказы»`);
  }
  sections.push(payers.join('\n'));

  const supportLines = ['Поддержка', `Обращений: ${support.requests}`];
  if (support.ratings > 0) {
    supportLines.push(
      `Оценок: ${support.ratings}, средняя ${String(support.ratingAverage ?? '—').replace('.', ',')}` +
        (support.lowRatings > 0 ? ` · низких (1–3): ${support.lowRatings}` : ''),
    );
  } else {
    supportLines.push('Оценок не было.');
  }
  sections.push(supportLines.join('\n'));

  const vcc = now.vcc
    ? `${formatUsdCents(now.vcc.balanceUsdCents)} (на ${formatMskTime(now.vcc.readAt)})`
    : 'не удалось прочитать';
  sections.push(
    [
      'Сейчас ждут',
      now.pending
        ? `Оплаты: ${now.pending.count} на ${formatKopecks(now.pending.sumKopecks)}`
        : 'Оплаты: не удалось прочитать',
      `Проверки платежа: ${countOrDash(now.holds)}`,
      `Ответа в поддержке: ${countOrDash(now.unansweredSupport)}`,
      `Карточный счёт: ${vcc}`,
    ].join('\n'),
  );

  sections.push(panelUrl('/admin/analytics', panelHost));
  return sections.join('\n\n');
}

/**
 * Текст отчёта. Влезает в одно сообщение Telegram всегда: если список оплат
 * раздувает текст за лимит, он укорачивается с конца, а хвост честно говорит
 * «и ещё N» — обрезать сообщение посреди строки или разбивать на два хуже.
 */
export function formatDailyReport(data: DailyReportData, panelHost: string | null | undefined): string {
  const title = `Отчёт за сутки: ${formatReportDate(data.day)}`;
  let shown = data.paid.items.length;
  for (;;) {
    const text = formatOpsMessage(
      { stream: 'reports', title, body: buildBody(data, shown, panelHost), preformatted: true },
      panelHost,
    );
    if (text.length <= TELEGRAM_MESSAGE_LIMIT || shown === 0) return text;
    shown -= 1;
  }
}
