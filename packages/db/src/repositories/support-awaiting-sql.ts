import { sql, type SQL } from 'drizzle-orm';

import { SUPPORT_REQUEST_META_KEY, SUPPORT_STATE_META_SOURCE } from '@oplati/types';

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
 *     обращение пришло флоу без режима (`source = 'support'` — двухшаговый флоу
 *     бота при выключенном помощнике: режим он не ставит по решению владельца).
 *     Маркер в сессии помощника обращением к человеку не считается.
 *  2. Последнее обращение не снято: ПОЗЖЕ последней строки с маркером нет ни
 *     ответа оператора, ни служебной строки «Закрыть» / «Вернуть помощнику».
 *     Закрытие — такой же ответ «вопрос исчерпан», как сообщение (Р6): без
 *     этого флоу без режима снимался только доставленным ответом, и спам или
 *     клиент, заблокировавший бота, висели в «+1» навсегда.
 *
 * «Подключиться» обращение НЕ снимает: взять себе — не значит ответить.
 * Новое сообщение клиента с маркером после закрытия снова даёт «без ответа» —
 * отсчёт идёт от ПОСЛЕДНЕГО маркера.
 *
 * Модуль без собственной логики выборки намеренно: запросы у троих разные
 * (страница, подсчёт, порог давности), а условие — одно.
 */

/** `source` обращения флоу без режима разговора. */
export const LEGACY_SUPPORT_REQUEST_SOURCE = 'support';

/** Переходы панели, которые снимают обращение наравне с ответом. */
export const SUPPORT_REQUEST_CLOSING_TRIGGERS = ['operator_close', 'operator_return'] as const;

/** Строка переписки — отметка поданного обращения. */
export function supportRequestMarkerSql(message: string): SQL {
  return sql`(${sql.raw(message)}.meta ->> ${SUPPORT_REQUEST_META_KEY}) = 'true'`;
}

/**
 * `source` ПОСЛЕДНЕЙ строки с маркером — агрегат для `GROUP BY conversation_id`
 * по строкам, уже отфильтрованным `supportRequestMarkerSql`.
 */
export function lastSupportRequestSourceSql(message: string): SQL {
  const m = sql.raw(message);
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
    (${input.handoffMode} = 'operator' OR ${input.lastSource} = ${LEGACY_SUPPORT_REQUEST_SOURCE})
    AND NOT ${supportRequestSettledSql(input.conversationId, input.lastRequestAt)}
  )`;
}
