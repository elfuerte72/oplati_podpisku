import 'server-only';

import { after } from 'next/server';

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
 * ⚠️ Доставка уходит в `after()` — ПОСЛЕ ответа Telegram. Обработчик апдейта
 * синхронный и живёт до 90 секунд, а claim дедупа (`lib/dedup.ts`) истекает на
 * сотой: пост в группу плюс личка каждому сотруднику с flood-retry могли бы
 * съесть этот бюджет, и Telegram переДОСТАВИЛ бы апдейт — клиент получил бы
 * второй ответ. Наблюдатель не имеет права стоить наблюдаемому доставки.
 *
 * Никогда не бросает: его сбой не должен ронять обработку апдейта.
 */

const log = childLogger('telegram.inbound-alert');

/** Окно дедупа на клиента. */
export const INBOUND_ALERT_DEDUP_MS = 30 * 60 * 1000;

/**
 * Потолок уведомлений на ВСЕХ клиентов за час.
 *
 * Дедуп на клиента защищает от серии сообщений одного человека, но не от
 * десятка аккаунтов сразу: каждый дал бы пост в тему плюс личку всем, кто
 * имеет право на раздел. Персонал в такой ситуации перестаёт читать канал —
 * то есть исход тот же, что при отсутствии уведомлений, только шумнее.
 *
 * Двадцать в час при нынешнем потоке (около сотни сообщений В НЕДЕЛЮ)
 * недостижимо обычной работой, поэтому упереться в него означает всплеск —
 * о нём персоналу сообщается один раз, дальше тишина до конца окна.
 */
export const INBOUND_ALERT_HOURLY_CAP = 20;
const CAP_WINDOW_MS = 60 * 60 * 1000;

/** Счётчик окна: живёт в памяти процесса, как и остальные дедупы алёртов. */
let capWindowStartedAt = 0;
let capSent = 0;

/** Только для тестов. */
export function resetInboundAlertCapForTests(): void {
  capWindowStartedAt = 0;
  capSent = 0;
}

/**
 * Отдаёт `true`, пока потолок не выбран. Ровно на превышении отдаёт `true`
 * ОДИН раз — для предупреждения персоналу, дальше `false` до конца окна.
 */
function withinCap(now: number): { allowed: boolean; capJustReached: boolean } {
  if (now - capWindowStartedAt > CAP_WINDOW_MS) {
    capWindowStartedAt = now;
    capSent = 0;
  }
  capSent += 1;
  if (capSent < INBOUND_ALERT_HOURLY_CAP) return { allowed: true, capJustReached: false };
  if (capSent === INBOUND_ALERT_HOURLY_CAP) return { allowed: true, capJustReached: true };
  return { allowed: false, capJustReached: false };
}

export type InboundAlertInput = {
  telegramId: number;
  firstName?: string | undefined;
  lastName?: string | undefined;
  username?: string | undefined;
  /** Текст клиента; для медиа — короткая пометка, самого файла персоналу не шлём. */
  text: string;
  updateId: number;
};

export async function notifyStaffAboutInboundMessage(
  input: InboundAlertInput,
  now: number = Date.now(),
): Promise<void> {
  const work = () => deliver(input, now);
  try {
    after(work);
  } catch {
    // Вне запроса Next (тест, скрипт) `after()` бросает — тогда синхронно, тем
    // же приёмом, что аналитика (`lib/analytics/track.ts`).
    await work();
  }
}

async function deliver(input: InboundAlertInput, now: number): Promise<void> {
  try {
    const cap = withinCap(now);
    if (!cap.allowed) {
      log.warn({ event: 'telegram.inbound_alert.capped', updateId: input.updateId });
      return;
    }
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
    const body = cap.capJustReached
      ? `${stripHtmlTags(message)}\n\nЗа последний час это ${INBOUND_ALERT_HOURLY_CAP} уведомление о входящих. Остальные до конца часа не придут — смотрите раздел «Поддержка».`
      : stripHtmlTags(message);
    const res = await notifyStaff(body, {
      capability: 'support',
      preformatted: true,
      // ⚠️ Набор опций доставки повторяет `sendToSupportOperator`
      // (`lib/telegram/support.ts`) намеренно: у обращения и у свободного
      // сообщения разные дедупы и заголовки, общая тут только адресация.
      // Меняешь контракт доставки обращений — проверь и это место.
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
