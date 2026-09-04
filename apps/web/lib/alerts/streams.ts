import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError } from 'grammy';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import type { PanelCapability } from '../panel/permissions.ts';
import { sendAlert } from '../telegram/alert-bot.ts';
import { sendStaffMessage, StaffBotNotConfiguredError } from '../telegram/staff-bot-client.ts';

/**
 * Потоки уведомлений и доставка в ops-группу (трек ops-group, 2026-09-04).
 *
 * Уведомления раньше приходили владельцу в три диалога с тремя ботами, и в
 * каждом важное было перемешано с неважным: «сайт лежит» и «на карточном счёте
 * не хватает на самый дорогой заказ» нельзя было различить, не открыв. Теперь
 * место одно — приватная супергруппа с темами, и КАЖДОЕ машинное сообщение
 * называет свой поток: тема со звуком ровно одна («Авария»), остальные читают,
 * когда есть время.
 *
 * Единственная точка доставки — `notifyStream`. Отправитель в группе — бот
 * ВХОДА (`TELEGRAM_LOGIN_BOT_TOKEN`): отдельного бота-отправителя больше нет
 * (решение владельца 2026-09-03). При незаданной группе работает прежняя схема
 * — личка `ALERT_TELEGRAM_CHAT_ID` через alert-бота (`sendAlert`); это режим
 * dev и страховка отката, а не долг.
 *
 * ⚠️ Анти-петля: сбой доставки в Sentry не уходит НИКОГДА — провал алёрта
 * породил бы новый issue → новый алёрт. Единственное исключение — протухший
 * thread id (тема удалена или пересоздана): это ошибка КОНФИГУРАЦИИ, о ней
 * нужно узнать, и она сообщается один раз на процесс; Sentry-релей отключает и
 * её (`reportToSentry: false`).
 */

export const ALERT_STREAMS = ['critical', 'payments', 'support', 'errors', 'deploy'] as const;

export type AlertStream = (typeof ALERT_STREAMS)[number];

const log = childLogger('alerts.streams');

/**
 * Поток для уведомления персоналу по разделу панели: обращения — в
 * «Поддержку», всё остальное, что видит оператор (холды, недожатые заказы,
 * исполнение, заказы, клиенты), — в «Платежи». Вызывающий может переопределить
 * поток явно (застрявший заказ и критический баланс идут в «Аварию»).
 *
 * ⚠️ Попадает ли раздел в группу вообще, решает НЕ эта таблица, а права роли
 * `operator` (`canAccess`, `notify-staff.ts`): «в группу попадает только то,
 * что видит оператор» — одно правило, выведенное из таблицы прав, а не второй
 * список, который разъехался бы с ней.
 */
export function streamForCapability(capability: PanelCapability): AlertStream {
  return capability === 'support' ? 'support' : 'payments';
}

export type OpsGroup = {
  chatId: string;
  /** `null` — тема не задана: сообщение уходит в корень группы. */
  threads: Readonly<Record<AlertStream, number | null>>;
};

/**
 * Конфигурация группы из env. `null` — группа не задана, работает прежняя
 * схема. Читается на каждый вызов, а не кэшируется: тесты и горячая правка
 * env не должны зависеть от порядка импортов.
 */
export function opsGroup(): OpsGroup | null {
  const chatId = serverEnv.OPS_GROUP_CHAT_ID;
  if (!chatId) return null;
  return {
    chatId,
    threads: {
      critical: parseThreadId(serverEnv.OPS_GROUP_THREAD_CRITICAL),
      payments: parseThreadId(serverEnv.OPS_GROUP_THREAD_PAYMENTS),
      support: parseThreadId(serverEnv.OPS_GROUP_THREAD_SUPPORT),
      errors: parseThreadId(serverEnv.OPS_GROUP_THREAD_ERRORS),
      deploy: parseThreadId(serverEnv.OPS_GROUP_THREAD_DEPLOY),
    },
  };
}

function parseThreadId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Настроена ли доставка ops-уведомлений хоть куда-нибудь: группа ИЛИ личка
 * прежней схемы. Нужно тем, кто решает «no-op или слать» до сборки текста
 * (Sentry-релей).
 */
export function isOpsDeliveryConfigured(): boolean {
  return opsGroup() !== null || Boolean(serverEnv.ALERT_TELEGRAM_CHAT_ID);
}

export type NotifyStreamOptions = {
  /**
   * Сообщать ли в Sentry о протухшем thread id. По умолчанию да (один раз на
   * процесс). Sentry-релей ставит `false`: он сам вызван алёртом Sentry, и
   * любое обращение к Sentry из него — начало петли.
   */
  reportToSentry?: boolean;
};

/**
 * Доставить текст в поток. Возвращает, СОСТОЯЛАСЬ ли доставка; никогда не
 * бросает — вызывающему это нужно не для обработки ошибки, а чтобы не
 * занимать окно дедупа несостоявшейся отправкой.
 */
export async function notifyStream(
  stream: AlertStream,
  text: string,
  opts: NotifyStreamOptions = {},
): Promise<boolean> {
  const group = opsGroup();
  if (group) return deliverToGroup(group, stream, text, opts);
  return deliverLegacy(stream, text);
}

async function deliverToGroup(
  group: OpsGroup,
  stream: AlertStream,
  text: string,
  opts: NotifyStreamOptions,
): Promise<boolean> {
  const threadId = group.threads[stream];
  try {
    await sendStaffMessage(group.chatId, text, threadId === null ? {} : { messageThreadId: threadId });
    log.info({ event: 'alerts.stream.sent', stream, threadId });
    return true;
  } catch (err) {
    if (err instanceof StaffBotNotConfiguredError) {
      // Группа задана, а токена бота входа нет — авария конфигурации. Фолбэка
      // на другого бота НЕТ намеренно: чужое имя в служебном канале хуже
      // молчания (принцип бота входа, `staff-bot-client.ts`).
      log.error({ event: 'alerts.stream.bot_not_configured', stream });
      return false;
    }
    if (threadId !== null && isThreadNotFound(err)) {
      // Тема удалена или пересоздана, а env остался старым. Алёрт важнее
      // порядка в группе: повтор в корень, чтобы ошибка конфигурации не
      // означала тишину, и одно сообщение в Sentry — чтобы её поправили.
      log.warn({ event: 'alerts.stream.thread_not_found', stream, threadId });
      reportStaleThread(stream, threadId, opts);
      return sendToRoot(group, stream, text);
    }
    log.error({ event: 'alerts.stream.failed', stream, err: describeTelegramError(err) });
    return false;
  }
}

async function sendToRoot(group: OpsGroup, stream: AlertStream, text: string): Promise<boolean> {
  try {
    await sendStaffMessage(group.chatId, text);
    log.info({ event: 'alerts.stream.sent', stream, threadId: null, fallback: 'root' });
    return true;
  } catch (err) {
    log.error({ event: 'alerts.stream.failed', stream, fallback: 'root', err: describeTelegramError(err) });
    return false;
  }
}

async function deliverLegacy(stream: AlertStream, text: string): Promise<boolean> {
  const chatId = serverEnv.ALERT_TELEGRAM_CHAT_ID;
  if (!chatId) {
    log.warn({ event: 'alerts.ops.disabled', reason: 'no_chat_id', stream });
    return false;
  }
  try {
    await sendAlert(chatId, text);
    log.info({ event: 'alerts.ops.sent', stream });
    return true;
  } catch (err) {
    log.error({ event: 'alerts.ops.failed', stream, err: describeTelegramError(err) });
    return false;
  }
}

/** Ответ Bot API на `message_thread_id` несуществующей темы. */
function isThreadNotFound(err: unknown): boolean {
  return err instanceof GrammyError && /message thread not found/i.test(err.description);
}

/** Протухшие темы, о которых уже сообщили: одно сообщение на thread id за процесс. */
const staleThreadsReported = new Set<string>();

function reportStaleThread(stream: AlertStream, threadId: number, opts: NotifyStreamOptions): void {
  if (opts.reportToSentry === false) return;
  const key = `${stream}:${threadId}`;
  if (staleThreadsReported.has(key)) return;
  staleThreadsReported.add(key);
  Sentry.captureMessage('Тема ops-группы не найдена — уведомления уходят в корень группы', {
    level: 'warning',
    tags: { source: 'alerts.streams' },
    extra: { stream, threadId },
  });
}

/**
 * Ошибка Telegram — без тела запроса: grammY кладёт `payload.text` в
 * перечисляемое поле, а текст уведомления может нести данные клиента (обращение
 * в поддержку целиком). Тот же урок, что у `telegram/support.ts`; общий для
 * всего слоя алёртов.
 */
export function describeTelegramError(err: unknown): unknown {
  if (err instanceof GrammyError) {
    return { name: err.name, errorCode: err.error_code, description: err.description };
  }
  return err;
}

/** Только для тестов. */
export function resetStreamsForTests(): void {
  staleThreadsReported.clear();
}
