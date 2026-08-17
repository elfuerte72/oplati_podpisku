import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, listStaffRecipients } from '@oplati/db';

import { notifyOps } from './notify-ops';

import { childLogger } from '@/lib/logger';
import { canAccess, type PanelCapability } from '@/lib/panel/permissions';
import { sendStaffMessage, StaffBotNotConfiguredError } from '@/lib/telegram/staff-bot-client';

import { DedupWindow } from './dedup-window';

/**
 * Уведомления ПЕРСОНАЛУ в Telegram (тикет 11, спека §7).
 *
 * Шлёт бот входа: сотрудник запускает его при первой авторизации, значит
 * доставка гарантирована — Telegram-бот не может писать тому, кто его не
 * запускал. Второго канала не заводим: три из четырёх событий уже частично
 * работали как DM владельцу, задача — расширить получателей, а не
 * продублировать.
 *
 * ⚠️ Получатели берутся из `staff`, а не из одной переменной
 * `SUPPORT_OPERATOR_CHAT_ID`: наёмный менеджер, заведённый скриптом, обязан
 * начать получать уведомления без правки env и редеплоя.
 *
 * ⚠️ Дедуп обязателен. Кроны бегают каждые 5 минут, и повторяющееся сообщение
 * через день перестают читать — ровно так был отключён алёрт баланса карт.
 * Окно задаёт вызывающий: у разных событий разная цена повтора.
 *
 * ⚠️ Никогда не бросает: уведомление — это наблюдатель, и его сбой не должен
 * ронять наблюдаемое (крон, вебхук, операцию панели).
 */

const log = childLogger('alerts.staff');

/** Общее окно дедупа на процесс: ключ и длительность задаёт вызывающий. */
const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;
const dedup = new DedupWindow(DEFAULT_DEDUP_WINDOW_MS);

/** Только для тестов. */
export function resetStaffNotifyDedupForTests(): void {
  dedup.resetForTests();
}

export type NotifyStaffResult = {
  /** Скольким сотрудникам доставлено. */
  delivered: number;
  /** Скольким не удалось (403 «не запускал бота» и прочее). */
  failed: number;
  /** Отправка не выполнялась: окно дедупа занято. */
  deduped: boolean;
};

export async function notifyStaff(
  text: string,
  opts: {
    dedupKey?: string;
    now?: number;
    /**
     * Кому это адресовано. Получатель без права на раздел уведомление НЕ
     * получает: таблица прав заведена, чтобы новая роль не «падала в
     * менеджера», и DM-канал не должен её обходить, отдавая переписку клиента
     * тому, кому экран закрыт.
     */
    capability: PanelCapability;
    /**
     * Окно дедупа. Дефолт — час; сутки нужны там, где состояние нормальное и
     * длительное (баланс между порогами), и ежечасное напоминание о нём —
     * способ, которым алёрт перестают читать.
     */
    dedupWindowMs?: number;
    /**
     * Слать ли владельцу (`notifyOps`), если персоналу не ушло ничего.
     *
     * ⚠️ По умолчанию ДА. На проде `staff` пуст до ручного заведения и первого
     * входа сотрудника, а у баланса карт и застрявшего заказа второго
     * телеграм-канала нет вовсе: без фолбэка требование «алёрт обязан приходить
     * в Telegram лично» после выката не выполнялось бы, и узнать об этом можно
     * было бы только из `log.warn`.
     */
    fallbackToOps?: boolean;
  },
): Promise<NotifyStaffResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  // ⚠️ Окно ПРОВЕРЯЕМ, но не занимаем: занять до попытки значит получить час
  // (а то и сутки) молчания при живой аварии — база моргнула, бот не настроен,
  // все получатели дали 403. Фиксируем только по факту доставки, ниже.
  if (opts.dedupKey && !dedup.isFree(opts.dedupKey, now, windowMs)) {
    log.debug({ event: 'alerts.staff.deduped', dedupKey: opts.dedupKey });
    return { delivered: 0, failed: 0, deduped: true };
  }

  let recipients: { id: string; telegramId: string }[] = [];
  try {
    // Узкая выборка: `listStaff` отдаёт строку целиком, вместе с `totp_secret`,
    // а работа этой функции — сформатировать текст для Telegram.
    const staff = await listStaffRecipients(getDb());
    recipients = staff
      .filter((member) => canAccess(member.role, opts.capability))
      .map((member) => ({ id: member.id, telegramId: member.telegramId }));
  } catch (err) {
    // База недоступна — сказать некому. Это не повод ронять вызывающего.
    log.error({ event: 'alerts.staff.recipients_failed', err });
    return { delivered: 0, failed: 0, deduped: false };
  }

  if (recipients.length === 0) {
    log.warn({ event: 'alerts.staff.no_recipients', capability: opts.capability });
    await fallback(text, opts);
    if (opts.dedupKey) dedup.record(opts.dedupKey, now, windowMs);
    return { delivered: 0, failed: 0, deduped: false };
  }

  let delivered = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await sendStaffMessage(recipient.telegramId, text);
      delivered++;
    } catch (err) {
      failed++;
      if (err instanceof StaffBotNotConfiguredError) {
        // Авария конфигурации: молчат ВСЕ, и перебирать остальных незачем.
        // Кричим отдельно — «не настроено» и «клиент заблокировал бота» это
        // разные новости с разными действиями.
        log.error({ event: 'alerts.staff.bot_not_configured' });
        Sentry.captureMessage('Бот персонала не настроен — уведомления не доставляются', {
          level: 'error',
          tags: { source: 'alerts.staff' },
        });
        failed = recipients.length;
        break;
      }
      // ⚠️ Отказ ОДНОМУ не отменяет остальных: сотрудник, не запустивший бота
      // входа, даёт 403, и без этого цикла из-за него молчали бы все.
      log.warn({ event: 'alerts.staff.send_failed', staffId: recipient.id, err });
    }
  }

  if (delivered === 0) await fallback(text, opts);

  // Окно занимает только СОСТОЯВШАЯСЯ доставка — хоть персоналу, хоть владельцу.
  if (opts.dedupKey && (delivered > 0 || opts.fallbackToOps !== false)) {
    dedup.record(opts.dedupKey, now, windowMs);
  }

  log.info({ event: 'alerts.staff.sent', delivered, failed });
  return { delivered, failed, deduped: false };
}

/**
 * Второй эшелон: владелец. Зовётся, только когда персоналу не ушло НИЧЕГО —
 * иначе владелец, заведённый и в `staff`, получал бы каждое сообщение дважды.
 */
async function fallback(
  text: string,
  opts: { capability: PanelCapability; fallbackToOps?: boolean },
): Promise<void> {
  if (opts.fallbackToOps === false) return;
  log.warn({ event: 'alerts.staff.fallback_to_ops', capability: opts.capability });
  Sentry.captureMessage('Уведомление персоналу не доставлено — ушло владельцу', {
    level: 'warning',
    tags: { source: 'alerts.staff' },
    extra: { capability: opts.capability },
  });
  await notifyOps(text);
}
