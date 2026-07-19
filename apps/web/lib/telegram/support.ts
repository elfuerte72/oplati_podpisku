import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError } from 'grammy';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import { getBot } from './bot';

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
    } else {
      log.error({ event: 'telegram.support.notify_failed', err, ...logCtx });
    }
    Sentry.captureException(err, { tags: { source: 'telegram.support' } });
    return false;
  }
}
