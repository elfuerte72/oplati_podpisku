import { and, eq, sql } from 'drizzle-orm';
import type { ConversationMode, ConversationModeTrigger } from '@oplati/types';
import {
  SUPPORT_AI_META_SOURCE,
  SUPPORT_STATE_META_SOURCE,
} from '@oplati/types';

import { conversations, messages } from '../schema.ts';
import type { DB, DBLike, DBTx } from '../index.ts';
import { emitDbChange } from '../change-feed.ts';
import {
  SUPPORT_MARK_ANSWERED_TRIGGER,
  awaitingOperatorSql,
  lastSupportRequestSourceSql,
  supportRequestMarkerSql,
} from './support-awaiting-sql.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * `Date` в raw-sql-фрагмент передавать нельзя — только ISO-строку (конвенция
 * кода): postgres-js на проде падает на сериализации, а PGlite в тестах `Date`
 * переваривает, и регресс невидим в зелёном прогоне.
 */
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Машина состояний разговора поддержки (спека `.scratch/support-ai/spec.md` §1).
 *
 * Единственный источник правды — строка `conversations`: `handoff_mode` (кто
 * отвечает), `mode_expires_at` (когда режим сам вернётся в `idle`),
 * `assigned_operator_id` (кто ведёт). Все переходы идут ЧЕРЕЗ ОДНУ функцию с
 * условным UPDATE — по образцу `transitionOrder`: два одновременных входящих
 * (жёсткий триггер и tool модели в одном ходе, две вкладки панели) иначе дали
 * бы два перехода, два уведомления персоналу и две служебные строки.
 */

export type ConversationState = {
  id: string;
  userId: string;
  mode: ConversationMode;
  modeExpiresAt: Date | null;
  assignedOperatorId: string | null;
};

export type TransitionConversationModeInput = {
  conversationId: string;
  /** Из какого режима (или любого из перечисленных) переход разрешён. */
  from: ConversationMode | readonly ConversationMode[];
  to: ConversationMode;
  /** Что вызвало переход — попадает в meta служебной строки и в аналитику. */
  trigger: ConversationModeTrigger;
  /** Человекочитаемая причина для оператора (категория слова, текст модели). */
  reason?: string | null;
  /**
   * Кто провёл переход руками — имя сотрудника из панели. Отдельное поле, а не
   * `reason`: причина отвечает «почему» (жёсткое слово, срок), а это — «кто».
   */
  actorName?: string | null;
  /**
   * Новый срок режима. Передаётся ВСЕГДА и явно: «забыли обновить» здесь
   * означает либо вечно живую сессию помощника, либо обращение, которое
   * тихо закрылось само.
   */
  modeExpiresAt: Date | null;
  /** Новый ведущий. `undefined` — поле не трогаем (touch ведущего не меняет). */
  assignedOperatorId?: string | null;
  /**
   * Захват: перейти можно, только если разговор свободен или уже за этим
   * сотрудником. Без этого условия ответ второго оператора перебивал бы
   * первого, и двое отвечали бы одному клиенту.
   */
  onlyIfFreeOrOwnedBy?: string;
};

export type TransitionConversationModeResult = {
  transitioned: boolean;
  /**
   * Режим не менялся — только продлён срок (повтор в том же режиме с тем же
   * ведущим). Служебной строки нет, события эскалации быть не должно.
   */
  touched?: boolean;
  /**
   * ФАКТИЧЕСКОЕ состояние из БД, а не запрошенное. Проигравший гонку обязан
   * плясать от того, что в базе: соврать ему «перевели в operator», когда там
   * уже `idle`, значит отправить клиенту обещание ответа, которого не будет.
   * `null` — разговора нет.
   */
  state: ConversationState | null;
};

const STATE_COLUMNS = {
  id: conversations.id,
  userId: conversations.userId,
  mode: conversations.handoffMode,
  modeExpiresAt: conversations.modeExpiresAt,
  assignedOperatorId: conversations.assignedOperatorId,
};

/** Текущее состояние разговора или `null`. */
export async function getConversationState(
  db: DBLike,
  conversationId: string,
): Promise<ConversationState | null> {
  const rows = await db
    .select(STATE_COLUMNS)
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Служебная строка `support_state` — ЕДИНСТВЕННЫЙ её писатель. Зовут двое:
 * состоявшийся переход режима и ручная отметка «отвечено» без смены режима.
 * Форму meta читают панель (`supportStateNote`), правило «ждёт человека» и
 * контекст помощника — вторая рукописная копия разъехалась бы с ними молча.
 */
async function insertModeStateRow(
  tx: DBTx,
  input: {
    conversationId: string;
    from: ConversationMode | null;
    to: ConversationMode;
    trigger: ConversationModeTrigger;
    reason?: string | null;
    actorName?: string | null;
  },
): Promise<void> {
  await tx.insert(messages).values({
    conversationId: input.conversationId,
    role: 'system',
    // Содержимое читаемо и без словаря (лог, psql при разборе инцидента);
    // подписи для панели собираются из meta.
    content: `${input.from ?? 'any'} → ${input.to}`,
    meta: {
      source: SUPPORT_STATE_META_SOURCE,
      from: input.from,
      to: input.to,
      trigger: input.trigger,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.actorName ? { actor: input.actorName } : {}),
    },
  });
}

/**
 * Перевести разговор в другой режим. Состоявшийся переход пишет служебную
 * строку `messages` с `role='system'` В ТОЙ ЖЕ ТРАНЗАКЦИИ: панель показывает
 * её как след «кто и почему передал», а разъехавшийся след хуже отсутствующего.
 *
 * Ноль строк на UPDATE — не ошибка, а «переход не состоялся»: режим уже
 * сменили, разговор захватил коллега, разговора нет вовсе.
 *
 * `DBLike`, как у `transitionOrderDetailed`: вызванная внутри чужой транзакции,
 * функция открывает вложенную (savepoint) — так ручная отметка «отвечено»
 * меняет режим этим же писателем, а не вторым рукописным UPDATE.
 */
export async function transitionConversationMode(
  db: DBLike,
  input: TransitionConversationModeInput,
  log: RepoLogger = noopLogger,
): Promise<TransitionConversationModeResult> {
  const { conversationId, to, trigger, reason = null, actorName = null, modeExpiresAt } = input;
  const fromModes: readonly ConversationMode[] =
    typeof input.from === 'string' ? [input.from] : input.from;

  return await db.transaction(async (tx) => {
    // ⚠️ Повтор в ТОМ ЖЕ режиме с ТЕМ ЖЕ ведущим — это touch, а не переход:
    // третий ответ оператора подряд не должен рисовать в ленте третью
    // служебную строку «→ operator» и третье событие эскалации. Служебные
    // строки — след настоящих переходов; их дубли похоронили бы ленту.
    if (fromModes.includes(to)) {
      const current = await getConversationState(tx, conversationId);
      const sameOwner =
        input.assignedOperatorId === undefined ||
        current?.assignedOperatorId === input.assignedOperatorId;
      // Тот же предикат «свободен или мой», что и у UPDATE ниже: без него
      // touch продлевал бы срок ЧУЖОГО разговора, который UPDATE отверг бы.
      const freeOrOwned =
        input.onlyIfFreeOrOwnedBy === undefined ||
        current?.assignedOperatorId === null ||
        current?.assignedOperatorId === input.onlyIfFreeOrOwnedBy;
      if (current && current.mode === to && sameOwner && freeOrOwned) {
        await tx.execute(sql`
          UPDATE conversations
             SET mode_expires_at = ${isoOrNull(modeExpiresAt)},
                 updated_at = now()
           WHERE id = ${conversationId}
        `);
        log.info({ event: 'db.support.transition_touch', conversationId, mode: to, trigger });
        return { transitioned: true, state: { ...current, modeExpiresAt }, touched: true };
      }
    }

    const conditions = [
      sql`id = ${conversationId}`,
      sql`handoff_mode IN (${sql.join(
        fromModes.map((m) => sql`${m}`),
        sql`, `,
      )})`,
    ];
    if (input.onlyIfFreeOrOwnedBy !== undefined) {
      conditions.push(
        sql`(assigned_operator_id IS NULL OR assigned_operator_id = ${input.onlyIfFreeOrOwnedBy})`,
      );
    }

    const assignments = [
      sql`handoff_mode = ${to}`,
      sql`mode_expires_at = ${isoOrNull(modeExpiresAt)}`,
      sql`updated_at = now()`,
    ];
    if (input.assignedOperatorId !== undefined) {
      assignments.push(sql`assigned_operator_id = ${input.assignedOperatorId}`);
    }

    const updated = await tx.execute<{
      id: string;
      user_id: string;
      handoff_mode: ConversationMode;
      mode_expires_at: Date | string | null;
      assigned_operator_id: string | null;
    }>(sql`
      UPDATE conversations
         SET ${sql.join(assignments, sql`, `)}
       WHERE ${sql.join(conditions, sql` AND `)}
      RETURNING id, user_id, handoff_mode, mode_expires_at, assigned_operator_id
    `);

    const row = updated[0];
    if (!row) {
      // Проигравший гонку читает факт. Отдельный SELECT, а не догадка по
      // входным данным: между UPDATE и чтением состояние уже могло смениться,
      // и врать о нём хуже, чем показать чуть устаревшее, но настоящее.
      const state = await getConversationState(tx, conversationId);
      log.info({
        event: 'db.support.transition_skipped',
        conversationId,
        from: fromModes,
        to,
        actualMode: state?.mode ?? null,
      });
      return { transitioned: false, state };
    }

    const fromMode = fromModes.length === 1 ? (fromModes[0] ?? null) : null;
    await insertModeStateRow(tx, { conversationId, from: fromMode, to, trigger, reason, actorName });

    log.info({ event: 'db.support.transitioned', conversationId, from: fromModes, to, trigger });
    // Панель слушает ленту изменений: режим — кто отвечает клиенту, а служебная
    // строка — часть ленты обращения.
    emitDbChange('conversations');
    emitDbChange('messages');

    return {
      transitioned: true,
      state: {
        id: row.id,
        userId: row.user_id,
        mode: row.handoff_mode,
        modeExpiresAt: row.mode_expires_at === null ? null : new Date(row.mode_expires_at),
        assignedOperatorId: row.assigned_operator_id,
      },
    };
  });
}

/**
 * Продлить (или обнулить) срок режима без смены самого режима.
 *
 * Служебную строку НЕ пишет: touch случается на каждое сообщение клиента и на
 * каждый ответ помощника, и след из них похоронил бы в ленте панели настоящие
 * переходы. Условие по режиму обязательно — иначе touch сессии помощника,
 * пришедший вдогонку за эскалацией, воскресил бы срок у разговора, который
 * уже ждёт человека и не должен гаснуть.
 */
export async function touchConversationMode(
  db: DBLike,
  input: { conversationId: string; mode: ConversationMode; modeExpiresAt: Date | null },
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE conversations
       SET mode_expires_at = ${isoOrNull(input.modeExpiresAt)},
           updated_at = now()
     WHERE id = ${input.conversationId}
       AND handoff_mode = ${input.mode}
    RETURNING id
  `);
  return rows.length > 0;
}

export type MarkSupportRequestAnsweredResult =
  | { status: 'marked'; state: ConversationState }
  /** Снимать нечего: уже ответили, закрыли, отметили — или обращения не было. */
  | { status: 'not_awaiting'; state: ConversationState }
  | { status: 'not_found' };

/**
 * Ручная отметка «отвечено»: клиенту ответили МИМО панели (личкой в Telegram
 * по ссылке `t.me/<username>` из карточки клиента), и строки оператора в
 * переписке от такого ответа не появляется — обращение висело бы «без ответа»
 * бессрочно, а сторож крона напоминал бы о нём каждые четыре часа.
 *
 * Клиенту НИЧЕГО не уходит — этим отметка и отличается от «Закрыть», которое
 * шлёт «оператор завершил обращение» и требует режима `operator`.
 *
 * Что делает, одной транзакцией:
 *
 *  - Берёт строку разговора под `FOR UPDATE` ПЕРВЫМ действием: две вкладки
 *    панели иначе обе видели бы «ждёт человека» и писали две служебные строки.
 *  - Проверяет «ждёт человека» ТЕМ ЖЕ `awaitingOperatorSql`, что список,
 *    счётчик и сторож: кнопка рисуется по флагу списка, и своё правило здесь
 *    означало бы кнопку, которая отвечает отказом.
 *  - Разговор у оператора переводит в `idle` единственным писателем режима —
 *    ведущий и срок снимаются, как у «Закрыть». ⚠️ Оставлять `operator` нельзя:
 *    `mode_expires_at IS NULL` в нём значит «ждём человека», крон такой
 *    разговор не закрывает никогда, и помощник молчал бы для этого клиента
 *    бессрочно при уже снятом обращении. В остальных режимах режим не
 *    трогается — пишется только служебная строка.
 *
 * Отметить можно и чужой разговор: это способ завершить, а не перехватить
 * (то же решение, что у «Закрыть»). Новое обращение клиента после отметки
 * снова даёт «без ответа» — отсчёт идёт от последнего маркера.
 */
export async function markSupportRequestAnswered(
  db: DB,
  input: { conversationId: string; actorName: string },
  log: RepoLogger = noopLogger,
): Promise<MarkSupportRequestAnsweredResult> {
  const { conversationId, actorName } = input;

  return await db.transaction(async (tx) => {
    const locked = await tx
      .select(STATE_COLUMNS)
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update')
      .limit(1);
    const current = locked[0];
    if (!current) return { status: 'not_found' };

    const rows = await tx.execute<{ awaiting: boolean | string | null }>(sql`
      WITH asked AS (
        SELECT m.conversation_id,
               max(m.created_at) AS last_request_at,
               ${lastSupportRequestSourceSql('m')} AS last_source
          FROM messages m
         WHERE m.conversation_id = ${conversationId}
           AND ${supportRequestMarkerSql('m')}
         GROUP BY m.conversation_id
      )
      SELECT ${awaitingOperatorSql({
        handoffMode: sql.raw('c.handoff_mode'),
        lastSource: sql.raw('a.last_source'),
        conversationId: sql.raw('a.conversation_id'),
        lastRequestAt: sql.raw('a.last_request_at'),
      })} AS awaiting
        FROM asked a
        JOIN conversations c ON c.id = a.conversation_id
    `);
    if (String(rows[0]?.awaiting) !== 'true') {
      log.info({ event: 'db.support.mark_answered_skipped', conversationId, mode: current.mode });
      return { status: 'not_awaiting', state: current };
    }

    if (current.mode === 'operator') {
      const res = await transitionConversationMode(
        tx,
        {
          conversationId,
          from: 'operator',
          to: 'idle',
          trigger: SUPPORT_MARK_ANSWERED_TRIGGER,
          actorName,
          modeExpiresAt: null,
          assignedOperatorId: null,
        },
        log,
      );
      // Строка под нашим локом, режим только что прочитан — несостоявшийся
      // переход здесь не гонка, а поломка. Бросаем: транзакция откатится, и
      // обращение не окажется «отмеченным» при разговоре, запертом у оператора.
      if (!res.transitioned || !res.state) {
        throw new Error(`markSupportRequestAnswered: переход operator → idle не состоялся (${conversationId})`);
      }
      return { status: 'marked', state: res.state };
    }

    await insertModeStateRow(tx, {
      conversationId,
      from: current.mode,
      to: current.mode,
      trigger: SUPPORT_MARK_ANSWERED_TRIGGER,
      actorName,
    });
    log.info({ event: 'db.support.marked_answered', conversationId, mode: current.mode });
    // Режим не менялся — панели достаточно знать про новую строку переписки.
    emitDbChange('messages');
    return { status: 'marked', state: current };
  });
}

export type SupportConversationRef = {
  conversationId: string;
  userId: string;
  /** `null` — клиент пришёл с сайта: доставить ему в Telegram нечего. */
  telegramId: string | null;
};

/**
 * Разговоры у оператора с истёкшим сроком — кандидаты на автозакрытие
 * (оператор ответил, клиент 24 часа молчит).
 *
 * ⚠️ `mode_expires_at IS NULL` в режиме `operator` означает «ждём ответа
 * человека» и в выборку НЕ попадает: неотвеченное обращение не закрывается
 * никогда.
 */
export async function findExpiredOperatorConversations(
  db: DB,
  opts: { limit: number },
): Promise<SupportConversationRef[]> {
  const rows = await db.execute<{
    conversation_id: string;
    user_id: string;
    telegram_id: string | null;
  }>(sql`
    SELECT c.id AS conversation_id, u.id AS user_id, u.telegram_id
      FROM conversations c
      JOIN users u ON u.id = c.user_id
     WHERE c.handoff_mode = 'operator'
       AND c.mode_expires_at IS NOT NULL
       AND c.mode_expires_at < now()
     ORDER BY c.mode_expires_at ASC
     LIMIT ${opts.limit}
  `);
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    userId: r.user_id,
    telegramId: r.telegram_id,
  }));
}

export type UnansweredSupportConversation = SupportConversationRef & {
  /** Когда клиент написал в последний раз — от этого считается «ждёт N часов». */
  lastClientMessageAt: Date;
};

/**
 * Обращения, которые ждут человека дольше порога, — сторож «без ответа».
 *
 * Правило «ждёт человека» — `awaitingOperatorSql`, ТО ЖЕ, что у списка и
 * счётчика панели (crm-serious-fixes, тикет 03). До тикета сторож требовал
 * режим `operator` и не видел ни одного обращения флоу без режима — то есть
 * весь поток прода при выключенном помощнике.
 *
 * Порог считаем от ПОСЛЕДНЕГО обращения: разговор один на клиента, и «когда-то
 * отвечали» означало бы, что повторное обращение постоянного клиента навсегда
 * числится отвеченным.
 */
export async function findUnansweredSupportConversations(
  db: DB,
  opts: { olderThan: Date; limit: number },
): Promise<UnansweredSupportConversation[]> {
  const rows = await db.execute<{
    conversation_id: string;
    user_id: string;
    telegram_id: string | null;
    last_client_at: Date | string;
  }>(sql`
    WITH asked AS (
      -- Маркер обращения на строке, а не любая реплика клиента: обращение
      -- создаёт кнопка (правило В3), а не факт того, что человек что-то написал.
      SELECT m.conversation_id,
             max(m.created_at) AS last_client_at,
             ${lastSupportRequestSourceSql('m')} AS last_source
        FROM messages m
       WHERE ${supportRequestMarkerSql('m')}
       GROUP BY m.conversation_id
    )
    SELECT c.id AS conversation_id, u.id AS user_id, u.telegram_id, a.last_client_at
      FROM asked a
      JOIN conversations c ON c.id = a.conversation_id
      JOIN users u ON u.id = c.user_id
     WHERE a.last_client_at < ${opts.olderThan.toISOString()}
       AND ${awaitingOperatorSql({
         handoffMode: sql.raw('c.handoff_mode'),
         lastSource: sql.raw('a.last_source'),
         conversationId: sql.raw('a.conversation_id'),
         lastRequestAt: sql.raw('a.last_client_at'),
       })}
     ORDER BY a.last_client_at ASC
     LIMIT ${opts.limit}
  `);
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    userId: r.user_id,
    telegramId: r.telegram_id,
    lastClientMessageAt: new Date(r.last_client_at),
  }));
}

/**
 * Сколько ответов помощник дал ЭТОМУ клиенту с момента `since` — суточный кап.
 *
 * Считается по БД, а не по Redis: у счётчика в Redis есть fail-open, и при
 * недоступности кэша один спамер крутил бы модель без предела. Клиент, а не
 * разговор: «Очистить диалог» не должно обнулять лимит.
 */
export async function countSupportAiReplies(
  db: DB,
  input: { userId: string; since: Date },
): Promise<number> {
  const rows = await db.execute<{ cnt: string | number }>(sql`
    SELECT count(*) AS cnt
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ${input.userId}
       AND m.role = 'assistant'
       AND (m.meta ->> 'source') = ${SUPPORT_AI_META_SOURCE}
       AND m.created_at >= ${input.since.toISOString()}
  `);
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Когда персоналу в последний раз уходил пинг о новом сообщении клиента в
 * ЭТОМ разговоре. Факт хранится в `messages.meta` строки клиента
 * (`staff_pinged_at`), а не в Redis: у Redis fail-open, и при его аварии
 * оператор получал бы пинг на каждое сообщение ждущего клиента.
 */
export async function findLastStaffFollowUpAt(
  db: DB,
  conversationId: string,
): Promise<Date | null> {
  const rows = await db.execute<{ at: Date | string }>(sql`
    SELECT (meta ->> 'staff_pinged_at') AS at
      FROM messages
     WHERE conversation_id = ${conversationId}
       AND meta ? 'staff_pinged_at'
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `);
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

/**
 * `meta.source` строк, которые в контекст помощника подавать НЕЛЬЗЯ.
 *
 * Разговор в БД один на клиента и копит всё подряд: приветствие Оплатишки на
 * каждый `/start`, подсказки «бот не молчит», реплики продажного агента. Дай
 * их помощнику — и окно из двадцати строк наполовину состоит из «/start» и
 * маскота на «ты», который спорит с его же системным текстом («вы не
 * Оплатишка»). Помощник начинает отвечать не своим голосом и не по делу.
 *
 * Денилист, а не allowlist: пропустить в контекст лишнее служебное сообщение
 * дешевле, чем потерять настоящую реплику клиента.
 *
 * ⚠️ Подставляется через `NOT IN`, а НЕ через `<> ALL (...)`: массив drizzle
 * разворачивает в кортеж `($1, $2, $3)`, а `ALL` требует массив или подзапрос —
 * запрос падал на синтаксисе (поймано тестом, до прода не доехало).
 */
const NON_CONVERSATIONAL_SOURCES = [
  'static_greeting',
  'silent_hint',
  // Ответ бота на реферальную ссылку («ты по приглашению» / «это твоя ссылка»,
  // 2026-09-05): маскот на «ты», к разговору с помощником отношения не имеет.
  'referral_feedback',
  'support_greeting',
  'support_follow_up_ping',
];

/**
 * Последние строки разговора для истории помощника.
 *
 * Служебные строки переходов отброшены В SQL, а не после выборки: иначе окно в
 * 20 строк наполовину состояло бы из невидимых клиенту записей, и помощник
 * получал бы половину контекста. По той же причине в SQL отброшены команды
 * бота: «/start» как реплика клиента не значит ничего.
 */
export async function loadSupportHistory(
  db: DB,
  input: { conversationId: string; limit: number },
): Promise<{ role: 'user' | 'assistant' | 'operator'; content: string; createdAt: Date }[]> {
  const rows = await db.execute<{
    role: 'user' | 'assistant' | 'operator';
    content: string;
    created_at: Date | string;
  }>(sql`
    SELECT role, content, created_at
      FROM messages
     WHERE conversation_id = ${input.conversationId}
       AND role <> 'system'
       AND coalesce(meta ->> 'source', '') NOT IN ${NON_CONVERSATIONAL_SOURCES}
       AND content NOT LIKE '/%'
     ORDER BY created_at DESC, id DESC
     LIMIT ${input.limit}
  `);

  return rows
    .reverse()
    .map((r) => ({ role: r.role, content: r.content, createdAt: new Date(r.created_at) }));
}
