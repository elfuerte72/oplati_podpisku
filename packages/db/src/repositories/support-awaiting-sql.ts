import { sql, type SQL } from 'drizzle-orm';

import {
  SUPPORT_FLOW_META_SOURCE,
  SUPPORT_REQUEST_META_KEY,
  SUPPORT_STATE_META_SOURCE,
  type ConversationModeTrigger,
} from '@oplati/types';

/**
 * ЕДИНСТВЕННОЕ определение «обращение ждёт человека» (crm-serious-fixes,
 * тикет 03) — по образцу `promo-redemption-sql.ts` и `holdsCondition`.
 *
 * Условие нужно ТРОИМ: списку `/admin/support` (подсветка «Без ответа»),
 * счётчику в меню и на рабочем столе, сторожу крона `support-housekeeping`
 * («без ответа > 2 ч»). До тикета у крона было своё правило (обязательный
 * режим `operator`), и весь поток прода — обращения флоу без режима — сторож
 * не видел никогда, а панель при этом горела «+1». Разъезд между «что красит
 * экран» и «о чём напоминает крон» глазами не сверят.
 *
 * Правило — ОБА слагаемых:
 *
 *  1. Кто может ждать человека: разговор в режиме `operator` ИЛИ последнее
 *     обращение пришло флоу без режима (`SUPPORT_FLOW_META_SOURCE` — двухшаговый флоу
 *     бота при выключенном помощнике: режим он не ставит по решению владельца).
 *     Маркер в сессии помощника обращением к человеку не считается.
 *  2. Последнее обращение не снято: ПОЗЖЕ последней строки с маркером нет ни
 *     ответа оператора, ни служебной строки «Закрыть» / «Вернуть помощнику» /
 *     «Отмечено отвеченным». Закрытие — такой же ответ «вопрос исчерпан», как
 *     сообщение (Р6): без этого флоу без режима снимался только доставленным
 *     ответом, и спам или клиент, заблокировавший бота, висели в «+1» навсегда.
 *     Ручная отметка (`markSupportRequestAnswered`) — для ответа МИМО панели:
 *     персонал пишет клиенту личкой в Telegram, и строки оператора в переписке
 *     от такого ответа не появляется.
 *
 * «Подключиться» обращение НЕ снимает: взять себе — не значит ответить.
 * Новое сообщение клиента с маркером после закрытия снова даёт «без ответа» —
 * отсчёт идёт от ПОСЛЕДНЕГО маркера.
 *
 * Модуль без собственной логики выборки намеренно: запросы у троих разные
 * (страница, подсчёт, порог давности), а условие — одно.
 */

/**
 * Переходы панели, которые снимают обращение наравне с ответом. Типизированы
 * enum'ом триггеров: переименуй триггер — сборка упадёт здесь, а не SQL молча
 * перестанет находить закрытия.
 */
export const SUPPORT_REQUEST_CLOSING_TRIGGERS = [
  'operator_close',
  'operator_return',
  'operator_mark_answered',
] as const satisfies readonly ConversationModeTrigger[];

/**
 * Триггер ручной отметки «отвечено». Именованная константа, а не литерал у
 * каждого читателя: его пишет `markSupportRequestAnswered` и по нему же список
 * панели достаёт время отметки для колонки «Ответили».
 */
export const SUPPORT_MARK_ANSWERED_TRIGGER =
  'operator_mark_answered' as const satisfies (typeof SUPPORT_REQUEST_CLOSING_TRIGGERS)[number];

/** Имя таблицы или алиас — строкой, как у соседних фрагментов. */
function alias(ref: SQL | string): SQL {
  return typeof ref === 'string' ? sql.raw(ref) : ref;
}

/** Строка переписки — отметка поданного обращения. */
export function supportRequestMarkerSql(message: SQL | string): SQL {
  return sql`(${alias(message)}.meta ->> ${SUPPORT_REQUEST_META_KEY}) = 'true'`;
}

/**
 * `source` ПОСЛЕДНЕЙ строки с маркером — агрегат для `GROUP BY conversation_id`
 * по строкам, уже отфильтрованным `supportRequestMarkerSql`.
 */
export function lastSupportRequestSourceSql(message: SQL | string): SQL {
  const m = alias(message);
  return sql`(array_agg(${m}.meta ->> 'source' ORDER BY ${m}.created_at DESC))[1]`;
}

/**
 * Обращение снято: позже `lastRequestAt` есть ответ оператора или служебная
 * строка закрытия / возврата помощнику.
 */
export function supportRequestSettledSql(conversationId: SQL, lastRequestAt: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM messages settled
     WHERE settled.conversation_id = ${conversationId}
       AND settled.created_at > ${lastRequestAt}
       AND (
         settled.role = 'operator'
         OR (
           settled.role = 'system'
           AND (settled.meta ->> 'source') = ${SUPPORT_STATE_META_SOURCE}
           AND (settled.meta ->> 'trigger') IN (${sql.join(
             SUPPORT_REQUEST_CLOSING_TRIGGERS.map((t) => sql`${t}`),
             sql`, `,
           )})
         )
       )
  )`;
}

/**
 * Обращение ждёт человека. Все аргументы — выражения той выборки, что зовёт:
 * режим разговора, `source` последнего обращения, id разговора, время
 * последнего обращения.
 */
export function awaitingOperatorSql(input: {
  handoffMode: SQL;
  lastSource: SQL;
  conversationId: SQL;
  lastRequestAt: SQL;
}): SQL {
  return sql`(
    (${input.handoffMode} = 'operator' OR ${input.lastSource} = ${SUPPORT_FLOW_META_SOURCE})
    AND NOT ${supportRequestSettledSql(input.conversationId, input.lastRequestAt)}
  )`;
}
