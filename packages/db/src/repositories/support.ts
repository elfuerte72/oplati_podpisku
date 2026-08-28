import { and, eq, sql } from 'drizzle-orm';
import type { ConversationMode, ConversationModeTrigger } from '@oplati/types';
import {
  SUPPORT_AI_META_SOURCE,
  SUPPORT_REQUEST_META_KEY,
  SUPPORT_STATE_META_SOURCE,
} from '@oplati/types';

import { conversations, messages } from '../schema.ts';
import type { DB, DBLike } from '../index.ts';
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
 * Перевести разговор в другой режим. Состоявшийся переход пишет служебную
 * строку `messages` с `role='system'` В ТОЙ ЖЕ ТРАНЗАКЦИИ: панель показывает
 * её как след «кто и почему передал», а разъехавшийся след хуже отсутствующего.
 *
 * Ноль строк на UPDATE — не ошибка, а «переход не состоялся»: режим уже
 * сменили, разговор захватил коллега, разговора нет вовсе.
 */
export async function transitionConversationMode(
  db: DB,
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

    const fromMode = fromModes.length === 1 ? fromModes[0] : null;
    await tx.insert(messages).values({
      conversationId,
      role: 'system',
      // Содержимое читаемо и без словаря (лог, psql при разборе инцидента);
      // подписи для панели собираются из meta.
      content: `${fromMode ?? 'any'} → ${to}`,
      meta: {
        source: SUPPORT_STATE_META_SOURCE,
        from: fromMode,
        to,
        trigger,
        ...(reason ? { reason } : {}),
        ...(actorName ? { actor: actorName } : {}),
      },
    });

    log.info({ event: 'db.support.transitioned', conversationId, from: fromModes, to, trigger });

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
 * Разговоры у оператора, где клиент ждёт ответа дольше порога.
 *
 * Считаем от ПОСЛЕДНЕГО сообщения клиента и требуем отсутствия ответа
 * оператора после него: разговор один на клиента, и «когда-то отвечали»
 * означало бы, что повторное обращение постоянного клиента навсегда числится
 * отвеченным.
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
      -- ТОТ ЖЕ предикат, что у панели (listSupportRequestsForPanel,
      -- countUnansweredSupportRequests): маркер обращения на строке, а не
      -- любая реплика клиента. Иначе бейдж «без ответа» в панели и пинг крона
      -- считались бы по разным правилам и расходились на живых разговорах.
      SELECT m.conversation_id, max(m.created_at) AS last_client_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE (m.meta ->> ${SUPPORT_REQUEST_META_KEY}) = 'true'
         AND c.handoff_mode = 'operator'
       GROUP BY m.conversation_id
    )
    SELECT c.id AS conversation_id, u.id AS user_id, u.telegram_id, a.last_client_at
      FROM asked a
      JOIN conversations c ON c.id = a.conversation_id
      JOIN users u ON u.id = c.user_id
     WHERE a.last_client_at < ${opts.olderThan.toISOString()}
       AND NOT EXISTS (
             SELECT 1 FROM messages o
              WHERE o.conversation_id = a.conversation_id
                AND o.role = 'operator'
                AND o.created_at > a.last_client_at
           )
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
