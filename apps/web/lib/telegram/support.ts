import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError } from 'grammy';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { getBot } from './bot';
import { notifyStaff } from '@/lib/alerts/notify-staff';

/**
 * Доставка сообщений оператору поддержки в личку Telegram. Общий модуль для
 * бота (/support) и личного кабинета («Не проходит оплата?» из Mini App).
 */

const log = childLogger('telegram.support');

/**
 * Целевой chat_id оператора поддержки — ТОЛЬКО из env (M-15 аудита, 2026-07-19:
 * прежний дефолт с telegram_id владельца в коде удалён — личный ID светился в
 * репозитории, а смена оператора требовала правки кода). Оператор должен один
 * раз запустить бота, иначе Telegram запретит слать ему личные сообщения (403).
 */
export function supportOperatorChatId(): string | null {
  return serverEnv.SUPPORT_OPERATOR_CHAT_ID ?? null;
}

/**
 * Шлёт готовый HTML оператору. Возвращает `false` при сбое (в т.ч. 403 —
 * оператор не запускал бота), чтобы caller честно сообщил пользователю.
 */
export async function sendToSupportOperator(
  operatorMessage: string,
  logCtx: Record<string, unknown> = {},
): Promise<boolean> {
  // Персонал из `staff` — основной адресат (тикет 11): наёмный менеджер обязан
  // начать получать обращения без правки env и редеплоя. Доставка идёт ботом
  // ВХОДА, который сотрудник запускает при первой авторизации.
  //
  // ⚠️ Переменная `SUPPORT_OPERATOR_CHAT_ID` осталась как второй эшелон и НЕ
  // удалена: пока в `staff` нет ни одной строки с telegram_id (первый выкат,
  // сброшенная база), обращение клиента иначе просто пропало бы. Считаем
  // доставленным, если сработал хотя бы один канал.
  const toStaff = await notifyStaffPlain(operatorMessage, logCtx);
  if (toStaff) {
    // ⚠️ Legacy-канал зовём ТОЛЬКО когда персоналу не ушло. Владелец заведён и
    // в `staff`, и в `SUPPORT_OPERATOR_CHAT_ID`: без этой ветки он получал бы
    // каждое обращение дважды, а тикет просил расширить получателей, а не
    // завести второй канал.
    return true;
  }

  const target = supportOperatorChatId();
  if (!target) {
    // Обращение клиента некому доставить — конфигурационная авария, не штатный
    // кейс: шумим в лог и Sentry, caller честно скажет клиенту «не получилось».
    log.error({ event: 'telegram.support.no_operator_configured', ...logCtx });
    Sentry.captureMessage('SUPPORT_OPERATOR_CHAT_ID не задан — обращение в поддержку не доставлено', {
      level: 'error',
      tags: { source: 'telegram.support' },
    });
    return false;
  }
  try {
    await getBot().api.sendMessage(target, operatorMessage, { parse_mode: 'HTML' });
    log.info({ event: 'telegram.support.notified', ...logCtx });
    return true;
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      // Оператор не запускал бота (или заблокировал) — DM невозможен. Критично.
      log.error({ event: 'telegram.support.operator_unreachable', target, ...logCtx });
    } else if (err instanceof GrammyError) {
      // Тело запроса (`err.payload.text`) — это ТЕКСТ ОБРАЩЕНИЯ клиента вместе
      // с контекстом заказа. grammY кладёт его в перечисляемое поле, и
      // `log.error({ err })` печатал бы всё это в stdout → Loki (аудит
      // 2026-07-28, тот же механизм, что утечка PAN в issue-card).
      log.error({
        event: 'telegram.support.notify_failed',
        errorCode: err.error_code,
        description: err.description,
        ...logCtx,
      });
    } else {
      log.error({
        event: 'telegram.support.notify_failed',
        message: err instanceof Error ? err.message : String(err),
        ...logCtx,
      });
    }
    Sentry.captureException(
      err instanceof GrammyError
        ? new Error(`GrammyError ${err.error_code}: ${err.description}`)
        : err,
      { tags: { source: 'telegram.support' } },
    );
    // Персоналу могло уйти — тогда обращение не потеряно, и говорить клиенту
    // «не получилось» было бы неправдой.
    return toStaff;
  }
}


/**
 * Доставка обращения персоналу из `staff` (тикет 11). Никогда не бросает:
 * legacy-канал остаётся вторым эшелоном, и его судьба решается отдельно.
 *
 * Текст HTML-ный, а бот входа шлёт простым текстом — теги вырезаем, а не
 * оставляем клиенту в виде `&lt;b&gt;`: сообщение читает человек.
 */
async function notifyStaffPlain(
  operatorMessage: string,
  logCtx: Record<string, unknown>,
): Promise<boolean> {
  try {
    // ⚠️ `fallbackToOps: false` намеренно: ниже по коду стоит legacy-канал
    // `SUPPORT_OPERATOR_CHAT_ID`, и с фолбэком владелец получал бы КАЖДОЕ
    // обращение дважды (разными ботами) плюс Sentry-warning на каждое — до тех
    // пор, пока в `staff` не появится первый сотрудник.
    const res = await notifyStaff(stripHtmlTags(operatorMessage), {
      capability: 'support',
      fallbackToOps: false,
    });
    return res.delivered > 0;
  } catch (err) {
    log.error({ event: 'telegram.support.staff_notify_failed', ...logCtx, err });
    return false;
  }
}

/**
 * Снятие разметки для бота персонала: обращение собирается как HTML (клиентский
 * бот шлёт с `parse_mode`), а бот входа отправляет простым текстом.
 *
 * ⚠️ Ссылка не выбрасывается, а РАСКРЫВАЕТСЯ: `<a href="tg://user?id=1">чат</a>`
 * → `чат (tg://user?id=1)`. Слепое удаление тегов оставляло менеджеру мёртвый
 * текст «Профиль: открыть чат», то есть превращало в ничто ровно ту кнопку,
 * ради которой строка и существует.
 *
 * ⚠️ Сущности раскодируются ПОСЛЕ снятия тегов. Обратный порядок превратил бы
 * экранированный текст клиента (`&lt;b&gt;`) в разметку и съел бы её.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
