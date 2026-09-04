import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  findExpiredOperatorConversations,
  findUnansweredSupportConversations,
  getDb,
  transitionConversationMode,
} from '@oplati/db';

import { notifyStaff } from '../alerts/notify-staff.ts';
import { trackServer } from '../analytics/track.ts';
import { childLogger } from '../logger.ts';
import { SUPPORT_CLOSED_BY_OPERATOR } from '../support/texts.ts';
import { getBot } from '../telegram/bot.ts';
import { isWithinOperatorHours } from '../telegram/templates.ts';

/**
 * Хозяйство поддержки (спека §9, тикет 06). Раз в 15 минут:
 *
 *   (а) автозакрытие — оператор ответил, клиент 24 часа молчит: разговор
 *       уходит в `idle`, клиенту «оператор завершил обращение»;
 *   (б) алёрт «без ответа» — клиент ждёт дольше двух часов в рабочее время:
 *       персоналу с правом `support` пинг, при пустом штате — владельцу.
 *
 * Обе ветки ловят свои ошибки сами: сбой автозакрытия не должен глушить алёрт
 * и наоборот. Неотвеченное обращение НЕ закрывается никогда — это не ветка
 * (а), у неё `mode_expires_at IS NULL`, и выборка её не видит по построению.
 */

const log = childLogger('support-housekeeping');

/** Сколько часов клиент ждёт ответа, прежде чем пинговать персонал. */
export const UNANSWERED_AFTER_HOURS = 2;

/**
 * Окно дедупа пинга — на разговор. Четыре часа: два пинга за рабочий день по
 * одному висящему обращению — достаточно, чтобы не забыть, и достаточно редко,
 * чтобы такие пинги продолжали читать.
 */
export const UNANSWERED_ALERT_DEDUP_MS = 4 * 60 * 60 * 1000;

/** Потолок на прогон: крон бежит часто, догонит на следующем. */
const BATCH_LIMIT = 100;

export type SupportHousekeepingResult = { closed: number; alerted: number };

async function autoClose(now: Date): Promise<number> {
  const db = getDb();
  const expired = await findExpiredOperatorConversations(db, { limit: BATCH_LIMIT });
  if (expired.length === 0) return 0;

  let closed = 0;
  for (const row of expired) {
    const res = await transitionConversationMode(db, {
      conversationId: row.conversationId,
      from: 'operator',
      to: 'idle',
      trigger: 'auto',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    // Не состоялся — успели раньше (оператор закрыл, клиент написал и сбросил
    // срок). Прощание такому клиенту слать нельзя: он либо уже получил его,
    // либо ждёт ответа.
    if (!res.transitioned) continue;
    closed += 1;

    trackServer({
      name: 'support_session_closed',
      telegramId: row.telegramId,
      props: { stage: 'auto' },
      eventKey: `support-auto-close-${row.conversationId}-${now.toISOString().slice(0, 13)}`,
    });

    // Best-effort: переход уже состоялся, и сорванная доставка его не откатит.
    // Клиент без Telegram (сайт) — доставлять некуда, закрываем молча.
    if (!row.telegramId) continue;
    try {
      await getBot().api.sendMessage(row.telegramId, SUPPORT_CLOSED_BY_OPERATOR);
    } catch (err) {
      log.warn({
        event: 'cron.support_housekeeping.close_notify_failed',
        conversationId: row.conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info({ event: 'cron.support_housekeeping.auto_closed', count: closed, candidates: expired.length });
  return closed;
}

async function alertUnanswered(now: Date): Promise<number> {
  // Ночью некому отвечать, а утром крон сам увидит то же обращение — пинг
  // придёт в рабочее время без нашей помощи.
  if (!isWithinOperatorHours(now)) return 0;

  const db = getDb();
  const olderThan = new Date(now.getTime() - UNANSWERED_AFTER_HOURS * 60 * 60 * 1000);
  const waiting = await findUnansweredSupportConversations(db, { olderThan, limit: BATCH_LIMIT });
  if (waiting.length === 0) return 0;

  let alerted = 0;
  for (const row of waiting) {
    const hours = Math.floor((now.getTime() - row.lastClientMessageAt.getTime()) / 3_600_000);
    const text =
      `Обращение без ответа ${hours} ч. Клиент ждёт в поддержке — ` +
      `ответить можно из панели, раздел «Поддержка».`;

    // Дедуп — по разговору и с окном на вызов: ключ без окна держал бы
    // «раз и навсегда», а нужно «раз в четыре часа, пока висит».
    // ⚠️ Фолбэк владельцу — ВСТРОЕННЫЙ (`notifyStaff` при пустом штате сам
    // зовёт `notifyOps`), а не свой `notifyOps` рядом: окно дедупа `notifyStaff`
    // занимает только по факту доставки — персоналу ИЛИ владельцу через свой
    // фолбэк. Свой обход фолбэка это окно не занимал, и на проде, где `staff`
    // пуст до заведения персонала, владелец получал бы пинг о том же обращении
    // на каждом прогоне — раз в 15 минут вместо раз в четыре часа.
    const res = await notifyStaff(text, {
      capability: 'support',
      dedupKey: `support-unanswered-${row.conversationId}`,
      dedupWindowMs: UNANSWERED_ALERT_DEDUP_MS,
      title: 'Обращение без ответа',
      facts: [{ label: 'Ждёт', value: `${hours} ч` }],
      action: { text: 'ответить клиенту', path: '/admin/support' },
    });
    if (res.deduped) continue;
    alerted += 1;
  }

  log.info({ event: 'cron.support_housekeeping.unanswered', count: alerted, candidates: waiting.length });
  return alerted;
}

export async function runSupportHousekeeping(
  opts: { now?: Date } = {},
): Promise<SupportHousekeepingResult> {
  const now = opts.now ?? new Date();

  let closed = 0;
  try {
    closed = await autoClose(now);
  } catch (err) {
    log.error({ event: 'cron.support_housekeeping.auto_close_failed', err });
    Sentry.captureException(err, { tags: { source: 'cron.support-housekeeping', step: 'auto_close' } });
  }

  let alerted = 0;
  try {
    alerted = await alertUnanswered(now);
  } catch (err) {
    log.error({ event: 'cron.support_housekeeping.alert_failed', err });
    Sentry.captureException(err, { tags: { source: 'cron.support-housekeeping', step: 'unanswered' } });
  }

  return { closed, alerted };
}
