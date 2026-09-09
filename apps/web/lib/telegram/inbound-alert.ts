import 'server-only';

import { notifyStaff } from '@/lib/alerts/notify-staff';
import { childLogger } from '@/lib/logger';

import { buildSupportOperatorMessage, INBOUND_ALERT_TITLE } from './templates';
import { stripHtmlTags } from './support';

/**
 * «Клиент написал в бота» — уведомление персоналу на ЛЮБОЕ входящее сообщение,
 * оставшееся без содержательного ответа (решение владельца 2026-09-09).
 *
 * Зачем отдельно от обращения: обращение создаётся ТОЛЬКО нажатием кнопки
 * «Поддержка» (правило В3, оно не меняется) — а человек, написавший «помогите»
 * и кнопку не нажавший, до сих пор оставался невидимым. 08.09 это стоило
 * клиента, который тринадцать часов ждал ответа и писал «мошенники» при живом
 * оплаченном заказе.
 *
 * ⚠️ Дедуп 30 минут на клиента: серия из десяти сообщений подряд — обычное
 * поведение расстроенного человека, и десять одинаковых пингов персоналу
 * закончились бы тем, что их перестанут читать (так уже было с алёртом баланса
 * карт). Окно живёт в памяти процесса, как у остальных алёртов: пропущенный
 * дубль дешевле пропущенного уведомления.
 *
 * Никогда не бросает: уведомление — наблюдатель, его сбой не должен ронять
 * обработку апдейта.
 */

const log = childLogger('telegram.inbound-alert');

/** Окно дедупа на клиента. */
export const INBOUND_ALERT_DEDUP_MS = 30 * 60 * 1000;

export type InboundAlertInput = {
  telegramId: number;
  firstName?: string | undefined;
  lastName?: string | undefined;
  username?: string | undefined;
  /** Текст клиента; для медиа — короткая пометка, самого файла персоналу не шлём. */
  text: string;
  updateId: number;
};

export async function notifyStaffAboutInboundMessage(input: InboundAlertInput): Promise<void> {
  try {
    // Шапка та же, что у обращения: имя, рабочая ссылка на личку (или прямая
    // правда, что её нет), id и текст. Отличается только заголовок — персонал
    // должен видеть, обращение это или человек просто написал.
    const message = buildSupportOperatorMessage({
      telegramId: input.telegramId,
      firstName: input.firstName,
      lastName: input.lastName,
      username: input.username,
      description: input.text,
      title: INBOUND_ALERT_TITLE,
    });
    const res = await notifyStaff(stripHtmlTags(message), {
      capability: 'support',
      preformatted: true,
      // И в тему группы, и личкой — как у обращения.
      alsoDirect: true,
      fallbackToOps: false,
      dedupKey: `inbound-${input.telegramId}`,
      dedupWindowMs: INBOUND_ALERT_DEDUP_MS,
      action: { text: 'ответить клиенту', path: '/admin/support' },
    });
    log.info({
      event: 'telegram.inbound_alert.sent',
      updateId: input.updateId,
      delivered: res.delivered,
      deduped: res.deduped,
    });
  } catch (err) {
    // `notifyStaff` по контракту не бросает; страховка на случай, если это
    // изменится. Клиенту ответ уже ушёл — ронять апдейт из-за наблюдателя
    // нельзя, иначе Telegram переДОСТАВИТ его и человек получит дубль.
    log.error({ event: 'telegram.inbound_alert.failed', updateId: input.updateId, err });
  }
}
