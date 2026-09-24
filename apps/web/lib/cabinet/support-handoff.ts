import 'server-only';

import { childLogger } from '../logger.ts';
import { sendSafely } from '../telegram/send.ts';
import { buildSupportHintKeyboard } from '../telegram/silent-hint.ts';
import { CABINET_SUPPORT_HANDOFF_TEXT } from '../telegram/templates.ts';

const log = childLogger('cabinet.support-handoff');

/**
 * «Написать в поддержку» из Mini App: бот присылает клиенту в чат сообщение с
 * кнопкой «Поддержка», а кабинет следом закрывается. Раньше кабинет просто
 * закрывался, и клиент оказывался в чате, где кнопку поддержки надо было
 * искать в меню `/start` выше по переписке.
 *
 * Кнопка — та же, что под подсказкой и в меню (`buildSupportHintKeyboard`,
 * callback `support`): второго входа в поддержку не появляется, обращение
 * по-прежнему создаёт только её нажатие (правило В3), и дальше работает
 * обычный флоу — с помощником или без.
 *
 * ⚠️ В `messages` сообщение НЕ пишется намеренно: бот держит «чего он ждёт от
 * клиента» (например, описания проблемы) в meta ПОСЛЕДНЕЙ своей реплики
 * (`readPendingMeta`), и запись этой подсказки затёрла бы начатый флоу —
 * клиент, которого уже попросили описать проблему, потерял бы его.
 *
 * `true` — сообщение доставлено. Вне апдейта Telegram номера апдейта нет,
 * поэтому в журнал `sendSafely` уходит 0.
 */
export async function sendCabinetSupportHandoff(telegramId: string): Promise<boolean> {
  const delivered = await sendSafely(
    Number(telegramId),
    CABINET_SUPPORT_HANDOFF_TEXT,
    0,
    buildSupportHintKeyboard(),
  );
  log.info({ event: 'cabinet.support_handoff', delivered });
  return delivered;
}
