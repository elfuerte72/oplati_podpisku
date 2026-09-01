import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { GrammyError } from 'grammy';
import type { InlineKeyboard } from 'grammy';

import {
  claimFunnelSend,
  countFunnelSendsSince,
  getDb,
  getFunnelUserState,
  getLastFunnelSendAt,
  hasActiveOperatorConversation,
} from '@oplati/db';
import type { FunnelKind } from '@oplati/types';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { getBot } from '@/lib/telegram/bot';
import { isWithinOperatorHours } from '@/lib/telegram/templates';

/**
 * Привратник воронки обратной связи — ЕДИНСТВЕННАЯ точка отправки её
 * сообщений (тикет 01): ни одна джоба не зовёт `getBot().api.sendMessage`
 * для воронки напрямую. Порядок проверок фиксирован спекой: флаг →
 * telegram-идентичность → не отписан → нет разговора у оператора → тихое
 * окно → бюджет → спец-правило вида → атомарный claim → отправка.
 *
 * Ответы на нажатия кнопок (`fb:*`) через привратник НЕ ходят — это реакция
 * на действие клиента, в бюджет она не входит.
 */

const log = childLogger('funnel.gate');

/** Бюджет исходящих: не больше одного сообщения в сутки и трёх в неделю. */
export const FUNNEL_DAILY_LIMIT = 1;
export const FUNNEL_WEEKLY_LIMIT = 3;
/** Повторная просьба об оценке — не раньше чем через 90 дней (история 13). */
export const RATING_REPEAT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FunnelSkipReason =
  /** Флаг RETENTION_FUNNEL_ENABLED выключен. */
  | 'disabled'
  /** Пользователь не найден в БД. */
  | 'user_not_found'
  /** У пользователя нет telegram-идентичности — канала доставки нет. */
  | 'no_telegram'
  /** Клиент нажал «Больше не напоминать». */
  | 'opted_out'
  /** Идёт разговор с оператором — поверх него воронка не пишет. */
  | 'operator_active'
  /** Тихое окно 22:00–10:00 МСК. */
  | 'quiet_hours'
  /** Дневной бюджет исчерпан (≥1 за сутки). */
  | 'budget_daily'
  /** Недельный бюджет исчерпан (≥3 за неделю). */
  | 'budget_weekly'
  /** order_rating: предыдущая просьба об оценке моложе 90 дней. */
  | 'rating_too_soon'
  /** Право на отправку уже занято (конкурент или прошлый прогон). */
  | 'already_claimed'
  /** Клиент заблокировал бота (403) — зафиксировано, не ретраится. */
  | 'blocked'
  /** Прочий отказ Telegram при отправке (лог + Sentry, claim уже занят). */
  | 'send_failed';

export type FunnelSendResult = { ok: true } | { ok: false; reason: FunnelSkipReason };

export type FunnelMessageContent = {
  text: string;
  keyboard?: InlineKeyboard;
};

export type SendFunnelMessageInput = {
  userId: string;
  kind: FunnelKind;
  /** Заказ-контекст (msg1/msg3); у order_rating он же арбитр claim'а. */
  orderId?: string;
  /**
   * Контент строится ЛЕНИВО — только когда все проверки пройдены и claim
   * занят: сборка бывает дорогой (имя сервиса, реферальная ссылка), а
   * большинство вызовов заканчивается отказом привратника.
   */
  build: () => Promise<FunnelMessageContent> | FunnelMessageContent;
  /** Для тестов; в проде не передаётся. */
  now?: Date;
};

/**
 * Проверяет все правила и отправляет сообщение воронки. Ожидаемые отказы —
 * Result (`{ok:false, reason}`), причины различимы для логов; неожиданное
 * (недоступная БД) — throw, обёртка per-item в джобе.
 *
 * ⚠️ Claim занимается ДО отправки (at-most-once, прецедент
 * `claimRenewalReminder`): сбой отправки после claim'а означает пропущенное
 * сообщение, а не дубль. Для маркетингового касания это правильная сторона
 * ошибки — большинство отказов Telegram здесь постоянные («бот заблокирован»),
 * и ретрай слал бы дубли живым людям ради мёртвых душ.
 */
export async function sendFunnelMessage(input: SendFunnelMessageInput): Promise<FunnelSendResult> {
  const now = input.now ?? new Date();

  if (!serverEnv.RETENTION_FUNNEL_ENABLED) {
    return refused(input, 'disabled');
  }

  const db = getDb();

  const user = await getFunnelUserState(db, input.userId);
  if (!user) return refused(input, 'user_not_found');
  if (!user.telegramId) return refused(input, 'no_telegram');
  if (user.funnelOptOutAt) return refused(input, 'opted_out');

  if (await hasActiveOperatorConversation(db, input.userId, now)) {
    return refused(input, 'operator_active');
  }

  // Тихое окно 22:00–10:00 МСК — ровно инверсия рабочих часов оператора,
  // поэтому переиспользуем isWithinOperatorHours, а не заводим зеркало границ.
  if (!isWithinOperatorHours(now)) {
    return refused(input, 'quiet_hours');
  }

  // Бюджет по скользящим окнам. Дедуп рассылки держит claim, бюджет — только
  // анти-спам: прогоны крона последовательны, и первый успех в проходе виден
  // счётчику следующего кандидата.
  const sentToday = await countFunnelSendsSince(db, input.userId, new Date(now.getTime() - DAY_MS));
  if (sentToday >= FUNNEL_DAILY_LIMIT) return refused(input, 'budget_daily');
  const sentThisWeek = await countFunnelSendsSince(
    db,
    input.userId,
    new Date(now.getTime() - 7 * DAY_MS),
  );
  if (sentThisWeek >= FUNNEL_WEEKLY_LIMIT) return refused(input, 'budget_weekly');

  if (input.kind === 'order_rating') {
    const lastRatingAt = await getLastFunnelSendAt(db, input.userId, 'order_rating');
    if (lastRatingAt && now.getTime() - lastRatingAt.getTime() < RATING_REPEAT_DAYS * DAY_MS) {
      return refused(input, 'rating_too_soon');
    }
  }

  const claimed = await claimFunnelSend(db, {
    userId: input.userId,
    kind: input.kind,
    orderId: input.orderId ?? null,
  });
  if (!claimed) return refused(input, 'already_claimed');

  const content = await input.build();
  try {
    // telegramId — СТРОКА (не Number): большие 64-битные chat_id теряют
    // точность в double (L4, прецедент напоминания о продлении).
    await getBot().api.sendMessage(user.telegramId, content.text, {
      ...(content.keyboard ? { reply_markup: content.keyboard } : {}),
    });
  } catch (err) {
    // Блокировка бота клиентом — штатный исход рассылки (история 18): claim
    // уже занят, повтора не будет; фиксируем логом без Sentry — алёртить не о
    // чем, клиент недостижим для ЛЮБОГО вида воронки.
    if (err instanceof GrammyError && err.error_code === 403) {
      log.info({ event: 'funnel.send.blocked', userId: input.userId, kind: input.kind });
      return { ok: false, reason: 'blocked' };
    }
    log.error({ event: 'funnel.send.failed', userId: input.userId, kind: input.kind, err });
    Sentry.captureException(err, {
      tags: { source: 'funnel.gate' },
      extra: { userId: input.userId, kind: input.kind },
    });
    return { ok: false, reason: 'send_failed' };
  }

  log.info({ event: 'funnel.send.ok', userId: input.userId, kind: input.kind });
  return { ok: true };
}

function refused(
  input: { userId: string; kind: FunnelKind },
  reason: FunnelSkipReason,
): FunnelSendResult {
  log.info({ event: 'funnel.send.skipped', userId: input.userId, kind: input.kind, reason });
  return { ok: false, reason };
}
