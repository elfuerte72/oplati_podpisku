import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, listStaffRecipients } from '@oplati/db';

import { formatOpsMessage, type OpsMessageOptions } from './format';
import { notifyOps } from './notify-ops';
import { type AlertStream, describeTelegramError, notifyStream, opsGroup, streamForCapability } from './streams';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';
import { canAccess, type PanelCapability } from '@/lib/panel/permissions';
import { sendStaffMessage, StaffBotNotConfiguredError } from '@/lib/telegram/staff-bot-client';

import { DedupWindow } from './dedup-window';

/**
 * Уведомления ПЕРСОНАЛУ в Telegram (тикет 11, спека §7; ops-группа — трек
 * ops-group, тикет 03).
 *
 * Шлёт бот входа. При заданной ops-группе — постом в тему по капабилити
 * (`streamForCapability`: обращения → «Поддержка», остальное → «Платежи»;
 * вызывающий может поднять событие в «Аварию» явным `stream`): оператор, когда
 * появится, просто добавляется в группу и видит всё сразу, ничего не запуская,
 * а после удаления из группы доступа к новым обращениям не имеет. Без группы —
 * личкой каждому сотруднику с правом на раздел (режим dev и страховка отката).
 *
 * ⚠️ В группу попадает ТОЛЬКО то, что видит оператор — правило выводится из
 * таблицы прав панели (`canAccess('operator', capability)`), а не из второго
 * списка. Разделы владельца (партнёрские выплаты, персонал) и при заданной
 * группе уходят личкой админам: права панели не должны обходиться через
 * Telegram.
 *
 * ⚠️ Получатели лички берутся из `staff`, а не из одной переменной: наёмный
 * менеджер, заведённый скриптом, обязан начать получать уведомления без
 * правки env и редеплоя.
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
  body: string,
  opts: OpsMessageOptions & {
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
    /**
     * Поток (тема ops-группы). По умолчанию выводится из капабилити
     * (`streamForCapability`); задаётся явно там, где событие важнее раздела —
     * застрявший заказ и критический баланс идут в «Аварию».
     */
    stream?: AlertStream;
  },
): Promise<NotifyStaffResult> {
  const now = opts.now ?? Date.now();
  const stream = opts.stream ?? streamForCapability(opts.capability);
  // Собираем один раз: и пост в группу, и личка, и фолбэк владельцу получают
  // одну и ту же форму — заголовок, тело, «Что делать».
  const text = formatOpsMessage({ title: opts.title, body, action: opts.action }, serverEnv.PANEL_HOST);
  const windowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  // ⚠️ Окно ПРОВЕРЯЕМ, но не занимаем: занять до попытки значит получить час
  // (а то и сутки) молчания при живой аварии — база моргнула, бот не настроен,
  // все получатели дали 403. Фиксируем только по факту доставки, ниже.
  if (opts.dedupKey && !dedup.isFree(opts.dedupKey, now)) {
    log.debug({ event: 'alerts.staff.deduped', dedupKey: opts.dedupKey });
    return { delivered: 0, failed: 0, deduped: true };
  }

  const group = opsGroup();
  if (group && canAccess('operator', opts.capability)) {
    // Пост в тему группы — общее место, поэтому фолбэк владельцу не нужен
    // (он в группе), а «доставлено» равно единице: адресат один. Окно дедупа
    // — по ФАКТУ поста, как и в личке ниже.
    const posted = await notifyStream(stream, text);
    if (opts.dedupKey && posted) dedup.record(opts.dedupKey, now, windowMs);
    log.info({ event: 'alerts.staff.posted', stream, posted, capability: opts.capability });
    return posted
      ? { delivered: 1, failed: 0, deduped: false }
      : { delivered: 0, failed: 1, deduped: false };
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
    // Окно — по ФАКТУ доставки владельцу, как и в основной ветке ниже: на
    // проде `staff` пуст до заведения персонала, и записанное по попытке окно
    // означало бы час молчания при незаданном канале владельца.
    const toOwner = await fallback(text, opts.capability, stream, opts.fallbackToOps);
    if (opts.dedupKey && toOwner) dedup.record(opts.dedupKey, now, windowMs);
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
      // Без тела запроса: grammY кладёт текст уведомления в `payload`, а это
      // может быть обращение клиента целиком.
      log.warn({ event: 'alerts.staff.send_failed', staffId: recipient.id, err: describeTelegramError(err) });
    }
  }

  const toOwner = delivered === 0 ? await fallback(text, opts.capability, stream, opts.fallbackToOps) : false;

  // Окно занимает только СОСТОЯВШАЯСЯ доставка — хоть персоналу, хоть владельцу.
  // ⚠️ Именно факт, а не намерение: `notifyOps` при незаданном
  // `ALERT_TELEGRAM_CHAT_ID` и при отказе Telegram молчит по построению
  // (анти-петля), и записанное по попытке окно давало бы час (а то и сутки)
  // тишины при живой аварии — том самом случае, ради которого фолбэк и есть.
  if (opts.dedupKey && (delivered > 0 || toOwner)) {
    dedup.record(opts.dedupKey, now, windowMs);
  }

  log.info({ event: 'alerts.staff.sent', delivered, failed });
  return { delivered, failed, deduped: false };
}

/**
 * Второй эшелон: владелец. Зовётся, только когда персоналу не ушло НИЧЕГО —
 * иначе владелец, заведённый и в `staff`, получал бы каждое сообщение дважды.
 *
 * ⚠️ При заданной ops-группе не зовётся никогда: сюда доходят только разделы
 * владельца (остальное ушло постом), а `notifyOps` при группе положил бы
 * партнёрскую выплату в тему, которую видит оператор.
 */
async function fallback(
  text: string,
  capability: PanelCapability,
  stream: AlertStream,
  enabled: boolean | undefined,
): Promise<boolean> {
  if (enabled === false) return false;
  if (opsGroup()) {
    // Ошибка конфигурации (у раздела владельца нет ни одного админа в `staff`
    // с Telegram) не должна означать тишину: Sentry-релей донесёт это до темы
    // «Ошибки», а само сообщение в группу не кладём — раздел закрыт оператору.
    log.warn({ event: 'alerts.staff.no_recipients_with_group', capability });
    Sentry.captureMessage('Уведомление по разделу владельца не доставлено — в staff нет админов', {
      level: 'warning',
      tags: { source: 'alerts.staff' },
      extra: { capability },
    });
    return false;
  }
  log.warn({ event: 'alerts.staff.fallback_to_ops', capability });
  Sentry.captureMessage('Уведомление персоналу не доставлено — ушло владельцу', {
    level: 'warning',
    tags: { source: 'alerts.staff' },
    extra: { capability },
  });
  return notifyOps(text, { stream });
}
