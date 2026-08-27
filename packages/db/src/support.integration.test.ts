import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { SUPPORT_AI_META_SOURCE, SUPPORT_STATE_META_SOURCE } from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { appendMessage } from './repositories/messages.ts';
import { claimSupportConversation } from './repositories/panel.ts';
import {
  countSupportAiReplies,
  loadSupportHistory,
  findExpiredOperatorConversations,
  findUnansweredSupportConversations,
  getConversationState,
  touchConversationMode,
  transitionConversationMode,
} from './repositories/support.ts';

/**
 * Машина состояний разговора поддержки на реальном Postgres (тикет 01).
 *
 * Проверяем внешнее поведение: какой режим и срок оказались в БД, появилась ли
 * служебная строка, что видит крон. Не «функция X позвала Y».
 */

let db: DB;
let seq = 0;

function firstOf<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`ожидалась строка: ${what}`);
  return row;
}

async function makeUser(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.users)
    .values({ telegramId: `tg-support-${++seq}`, ...over })
    .returning();
  return firstOf(rows, 'users insert');
}

async function makeStaff(over: Partial<typeof schema.staff.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.staff)
    .values({
      telegramId: `staff-${++seq}`,
      email: `op-${seq}@example.test`,
      displayName: `Оператор ${seq}`,
      role: 'operator',
      ...over,
    })
    .returning();
  return firstOf(rows, 'staff insert');
}

/** Разговор в нужном режиме. Режим ставим напрямую — это подготовка, не проверка. */
async function makeConversation(opts: {
  mode?: 'idle' | 'ai' | 'operator';
  modeExpiresAt?: Date | null;
  assignedOperatorId?: string | null;
  userId?: string;
} = {}) {
  const userId = opts.userId ?? (await makeUser()).id;
  const rows = await db
    .insert(schema.conversations)
    .values({
      userId,
      channel: 'telegram',
      ...(opts.mode ? { handoffMode: opts.mode } : {}),
      modeExpiresAt: opts.modeExpiresAt ?? null,
      assignedOperatorId: opts.assignedOperatorId ?? null,
    })
    .returning();
  return firstOf(rows, 'conversations insert');
}

async function systemRows(conversationId: string) {
  return await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.role, 'system')));
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

beforeAll(async () => {
  ({ db } = await createTestDb());
});

describe('миграция режимов разговора', () => {
  it('дефолт разговора — idle, а не ai: бот не должен считать нового клиента говорящим с помощником', async () => {
    const conversation = await makeConversation();
    expect(conversation.handoffMode).toBe('idle');
    expect(conversation.modeExpiresAt).toBeNull();
  });

  it('backfill переносит существующие ai → idle, но НЕ трогает разговоры с оператором', async () => {
    // Отдельная база, остановленная ПЕРЕД парой миграций поддержки: на пустой
    // базе backfill ничего не переносит, и тест был бы зелёным даже с забытым
    // UPDATE. Здесь строки создаются старым дефолтом `ai`, как на проде.
    const legacy = await createTestDb({ stopBefore: '0041_' });

    const userRows = await legacy.db
      .insert(schema.users)
      .values([{ telegramId: 'tg-legacy-ai' }, { telegramId: 'tg-legacy-operator' }])
      .returning();
    const [aiUser, operatorUser] = [firstOf(userRows, 'user'), userRows[1]];
    if (!operatorUser) throw new Error('ожидались две строки users');

    await legacy.db.execute(sql`
      INSERT INTO conversations (user_id, channel, handoff_mode)
      VALUES (${aiUser.id}, 'telegram', 'ai'), (${operatorUser.id}, 'telegram', 'operator')
    `);

    await legacy.applyRemainingMigrations();

    const modes = await legacy.db.execute<{ handoff_mode: string; mode_expires_at: Date | null }>(
      sql`SELECT handoff_mode, mode_expires_at FROM conversations ORDER BY handoff_mode`,
    );
    expect(modes.map((r) => r.handoff_mode).sort()).toEqual(['idle', 'operator']);
    // Новая колонка появляется пустой: срока у унаследованных режимов нет.
    expect(modes.every((r) => r.mode_expires_at === null)).toBe(true);
  });
});

describe('transitionConversationMode', () => {
  it('idle → ai: ставит срок и пишет ровно одну служебную строку', async () => {
    const conversation = await makeConversation();
    const expiresAt = minutesFromNow(30);

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'idle',
      to: 'ai',
      trigger: 'button',
      modeExpiresAt: expiresAt,
      assignedOperatorId: null,
    });

    expect(res.transitioned).toBe(true);
    expect(res.state?.mode).toBe('ai');
    expect(res.state?.modeExpiresAt?.getTime()).toBe(expiresAt.getTime());

    const rows = await systemRows(conversation.id);
    expect(rows).toHaveLength(1);
    expect(firstOf(rows, 'system').meta).toMatchObject({
      source: SUPPORT_STATE_META_SOURCE,
      from: 'idle',
      to: 'ai',
      trigger: 'button',
    });
  });

  it('переход из НЕ того режима не проходит и возвращает ФАКТИЧЕСКОЕ состояние, а не запрошенное', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: minutesFromNow(10) });

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'idle',
      to: 'ai',
      trigger: 'button',
      modeExpiresAt: minutesFromNow(30),
    });

    expect(res.transitioned).toBe(false);
    expect(res.state?.mode).toBe('operator');
    expect(await systemRows(conversation.id)).toHaveLength(0);
  });

  it('двойной переход: второй ai → operator не проходит — условие по режиму его отвергает', async () => {
    // ⚠️ Это НЕ доказательство атомарности под нагрузкой: PGlite — одно
    // соединение в процессе, и обе транзакции сериализуются его же очередью.
    // Проверяется здесь ровно то, что и должно: условный UPDATE отвергает
    // переход, когда режим уже сменился, — а не то, что БД разруливает гонку.
    // Настоящая гонка живёт на боевом Postgres и держится тем же условием.
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });

    const results = await Promise.all([
      transitionConversationMode(db, {
        conversationId: conversation.id,
        from: 'ai',
        to: 'operator',
        trigger: 'hard',
        modeExpiresAt: null,
      }),
      transitionConversationMode(db, {
        conversationId: conversation.id,
        from: 'ai',
        to: 'operator',
        trigger: 'model',
        modeExpiresAt: null,
      }),
    ]);

    expect(results.filter((r) => r.transitioned)).toHaveLength(1);
    expect(await systemRows(conversation.id)).toHaveLength(1);
  });

  it('ai → operator: неотвеченное обращение НЕ гаснет — срок обнуляется', async () => {
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });

    await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'ai',
      to: 'operator',
      trigger: 'hard',
      reason: 'человек',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });

    const state = await getConversationState(db, conversation.id);
    expect(state?.mode).toBe('operator');
    expect(state?.modeExpiresAt).toBeNull();
    expect(state?.assignedOperatorId).toBeNull();
    expect(firstOf(await systemRows(conversation.id), 'system').meta).toMatchObject({
      trigger: 'hard',
      reason: 'человек',
    });
  });

  it('захват оператором из ЛЮБОГО режима: свободный разговор достаётся первому', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: ['idle', 'ai', 'operator'],
      to: 'operator',
      trigger: 'operator_reply',
      modeExpiresAt: minutesFromNow(24 * 60),
      assignedOperatorId: operator.id,
      onlyIfFreeOrOwnedBy: operator.id,
    });

    expect(res.transitioned).toBe(true);
    expect(res.state?.assignedOperatorId).toBe(operator.id);
  });

  it('чужой разговор захватить нельзя: возвращается состояние с прежним ведущим', async () => {
    const first = await makeStaff();
    const second = await makeStaff();
    const conversation = await makeConversation({ mode: 'operator', assignedOperatorId: first.id });

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: ['idle', 'ai', 'operator'],
      to: 'operator',
      trigger: 'operator_reply',
      modeExpiresAt: minutesFromNow(24 * 60),
      assignedOperatorId: second.id,
      onlyIfFreeOrOwnedBy: second.id,
    });

    expect(res.transitioned).toBe(false);
    expect(res.state?.assignedOperatorId).toBe(first.id);
  });

  it('operator → ai («вернуть помощнику»): ведущий снимается, срок 30 минут', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({ mode: 'operator', assignedOperatorId: operator.id });
    const expiresAt = minutesFromNow(30);

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'operator',
      to: 'ai',
      trigger: 'operator_return',
      modeExpiresAt: expiresAt,
      assignedOperatorId: null,
    });

    expect(res.transitioned).toBe(true);
    expect(res.state?.assignedOperatorId).toBeNull();
    expect(res.state?.modeExpiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('operator → idle («закрыть»): срок и ведущий обнуляются', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({
      mode: 'operator',
      assignedOperatorId: operator.id,
      modeExpiresAt: minutesFromNow(60),
    });

    await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'operator',
      to: 'idle',
      trigger: 'operator_close',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });

    const state = await getConversationState(db, conversation.id);
    expect(state?.mode).toBe('idle');
    expect(state?.modeExpiresAt).toBeNull();
    expect(state?.assignedOperatorId).toBeNull();
  });

  it('несуществующий разговор: перехода нет и состояния нет', async () => {
    const res = await transitionConversationMode(db, {
      conversationId: '00000000-0000-0000-0000-000000000000',
      from: 'idle',
      to: 'ai',
      trigger: 'button',
      modeExpiresAt: null,
    });
    expect(res.transitioned).toBe(false);
    expect(res.state).toBeNull();
  });
});

describe('touchConversationMode', () => {
  it('продлевает срок, НЕ плодя служебных строк', async () => {
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(1) });
    const next = minutesFromNow(30);

    const touched = await touchConversationMode(db, {
      conversationId: conversation.id,
      mode: 'ai',
      modeExpiresAt: next,
    });

    expect(touched).toBe(true);
    expect((await getConversationState(db, conversation.id))?.modeExpiresAt?.getTime()).toBe(next.getTime());
    expect(await systemRows(conversation.id)).toHaveLength(0);
  });

  it('сообщение клиента в режиме operator сбрасывает срок в null — ждём ответа человека', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: minutesFromNow(24 * 60) });

    await touchConversationMode(db, {
      conversationId: conversation.id,
      mode: 'operator',
      modeExpiresAt: null,
    });

    expect((await getConversationState(db, conversation.id))?.modeExpiresAt).toBeNull();
  });

  it('режим разошёлся с ожидаемым — срок не трогается', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: null });

    const touched = await touchConversationMode(db, {
      conversationId: conversation.id,
      mode: 'ai',
      modeExpiresAt: minutesFromNow(30),
    });

    expect(touched).toBe(false);
    expect((await getConversationState(db, conversation.id))?.modeExpiresAt).toBeNull();
  });
});

describe('выборки крона поддержки', () => {
  it('автозакрытие берёт только operator с истёкшим сроком', async () => {
    const expired = await makeConversation({ mode: 'operator', modeExpiresAt: hoursAgo(1) });
    const alive = await makeConversation({ mode: 'operator', modeExpiresAt: minutesFromNow(60) });
    const waiting = await makeConversation({ mode: 'operator', modeExpiresAt: null });
    const aiExpired = await makeConversation({ mode: 'ai', modeExpiresAt: hoursAgo(1) });

    const rows = await findExpiredOperatorConversations(db, { limit: 50 });
    const ids = rows.map((r) => r.conversationId);

    expect(ids).toContain(expired.id);
    expect(ids).not.toContain(alive.id);
    expect(ids).not.toContain(waiting.id);
    expect(ids).not.toContain(aiExpired.id);
  });

  it('автозакрытие отдаёт telegram_id клиента — иначе некому отправить прощание', async () => {
    const user = await makeUser({ telegramId: `tg-close-${++seq}` });
    const conversation = await makeConversation({
      mode: 'operator',
      modeExpiresAt: hoursAgo(1),
      userId: user.id,
    });

    const row = (await findExpiredOperatorConversations(db, { limit: 50 })).find(
      (r) => r.conversationId === conversation.id,
    );
    expect(row?.telegramId).toBe(user.telegramId);
  });

  it('«без ответа»: клиент ждёт дольше порога — попадает в выборку', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: null });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'помогите' });
    await db
      .update(schema.messages)
      .set({ createdAt: hoursAgo(3) })
      .where(eq(schema.messages.conversationId, conversation.id));

    const ids = (await findUnansweredSupportConversations(db, { olderThan: hoursAgo(2), limit: 50 })).map(
      (r) => r.conversationId,
    );
    expect(ids).toContain(conversation.id);
  });

  it('«без ответа»: оператор ответил ПОСЛЕ обращения — не напоминаем', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({ mode: 'operator', assignedOperatorId: operator.id });
    const asked = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'помогите',
    });
    await db.update(schema.messages).set({ createdAt: hoursAgo(3) }).where(eq(schema.messages.id, asked.id));
    const replied = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'разбираюсь',
      staffId: operator.id,
    });
    await db.update(schema.messages).set({ createdAt: hoursAgo(1) }).where(eq(schema.messages.id, replied.id));

    const ids = (await findUnansweredSupportConversations(db, { olderThan: hoursAgo(2), limit: 50 })).map(
      (r) => r.conversationId,
    );
    expect(ids).not.toContain(conversation.id);
  });

  it('«без ответа»: клиент написал только что — порог не пройден', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: null });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'ещё вопрос' });

    const ids = (await findUnansweredSupportConversations(db, { olderThan: hoursAgo(2), limit: 50 })).map(
      (r) => r.conversationId,
    );
    expect(ids).not.toContain(conversation.id);
  });

  it('«без ответа»: разговор у помощника не считается обращением к человеку', async () => {
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });
    const asked = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'вопрос',
    });
    await db.update(schema.messages).set({ createdAt: hoursAgo(5) }).where(eq(schema.messages.id, asked.id));

    const ids = (await findUnansweredSupportConversations(db, { olderThan: hoursAgo(2), limit: 50 })).map(
      (r) => r.conversationId,
    );
    expect(ids).not.toContain(conversation.id);
  });
});

describe('countSupportAiReplies (кап 100 ходов в сутки)', () => {
  it('считает ответы помощника этого клиента по всем его разговорам', async () => {
    const user = await makeUser();
    const first = await makeConversation({ userId: user.id, mode: 'ai' });
    const second = await makeConversation({ userId: user.id, mode: 'ai' });

    for (const conversationId of [first.id, second.id]) {
      await appendMessage(db, {
        conversationId,
        role: 'assistant',
        content: 'ответ помощника',
        meta: { source: SUPPORT_AI_META_SOURCE },
      });
    }

    expect(await countSupportAiReplies(db, { userId: user.id, since: hoursAgo(24) })).toBe(2);
  });

  it('чужие ответы, ответы продажного агента и старые ходы не считаются', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const mine = await makeConversation({ userId: user.id, mode: 'ai' });
    const alien = await makeConversation({ userId: other.id, mode: 'ai' });

    await appendMessage(db, {
      conversationId: alien.id,
      role: 'assistant',
      content: 'чужой ответ',
      meta: { source: SUPPORT_AI_META_SOURCE },
    });
    await appendMessage(db, {
      conversationId: mine.id,
      role: 'assistant',
      content: 'продажный агент',
      meta: { source: 'agent' },
    });
    const old = await appendMessage(db, {
      conversationId: mine.id,
      role: 'assistant',
      content: 'вчерашний ход',
      meta: { source: SUPPORT_AI_META_SOURCE },
    });
    await db.update(schema.messages).set({ createdAt: hoursAgo(30) }).where(eq(schema.messages.id, old.id));

    expect(await countSupportAiReplies(db, { userId: user.id, since: hoursAgo(24) })).toBe(0);
  });
});

describe('loadSupportHistory (контекст помощника)', () => {
  it('служебные строки, приветствие Оплатишки, подсказки и команды в контекст НЕ идут', async () => {
    const conversation = await makeConversation({ mode: 'ai' });

    // Разговор в БД один на клиента и копит всё подряд: маскот на «ты» спорил
    // бы с системным текстом помощника («вы не Оплатишка»), а «/start» как
    // реплика клиента не значит ничего — и оба съедали бы окно в 20 строк.
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: '/start' });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Привет! Я Оплатишка, помогу оплатить подписку.',
      meta: { source: 'static_greeting' },
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'В переписке я не отвечаю',
      meta: { source: 'silent_hint' },
    });
    await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'ai',
      to: 'operator',
      trigger: 'hard',
      modeExpiresAt: null,
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'когда придёт карта?',
    });

    const history = await loadSupportHistory(db, { conversationId: conversation.id, limit: 20 });
    expect(history.map((r) => r.content)).toEqual(['когда придёт карта?']);
  });

  it('настоящие реплики клиента, помощника и оператора остаются и идут в хронологии', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({ mode: 'ai' });

    // ⚠️ Время проставляем явно. `now()` в Postgres — время ТРАНЗАКЦИИ, и три
    // вставки подряд в тесте попадают в одну микросекунду; порядок внутри
    // ничьей разрешает тай-брейкер по случайному uuid, то есть произволен.
    // В проде реплики разделены секундами разговора, ничьих там нет.
    const first = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'первый',
    });
    const second = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'второй',
      meta: { source: SUPPORT_AI_META_SOURCE },
    });
    const third = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'третий',
      staffId: operator.id,
    });
    await db.update(schema.messages).set({ createdAt: hoursAgo(3) }).where(eq(schema.messages.id, first.id));
    await db.update(schema.messages).set({ createdAt: hoursAgo(2) }).where(eq(schema.messages.id, second.id));
    await db.update(schema.messages).set({ createdAt: hoursAgo(1) }).where(eq(schema.messages.id, third.id));

    const history = await loadSupportHistory(db, { conversationId: conversation.id, limit: 20 });
    expect(history.map((r) => `${r.role}:${r.content}`)).toEqual([
      'user:первый',
      'assistant:второй',
      'operator:третий',
    ]);
  });

  it('окно режет ХВОСТ переписки, а не начало', async () => {
    const conversation = await makeConversation({ mode: 'ai' });
    let ago = 3;
    for (const n of ['a', 'b', 'c']) {
      const row = await appendMessage(db, { conversationId: conversation.id, role: 'user', content: n });
      await db
        .update(schema.messages)
        .set({ createdAt: hoursAgo(ago--) })
        .where(eq(schema.messages.id, row.id));
    }

    const history = await loadSupportHistory(db, { conversationId: conversation.id, limit: 2 });
    expect(history.map((r) => r.content)).toEqual(['b', 'c']);
  });
});

describe('совместимость с панелью', () => {
  it('«подключиться» из панели работает поверх нового дефолта idle', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation();

    expect(await claimSupportConversation(db, { conversationId: conversation.id, staffId: operator.id })).toBe(
      'claimed',
    );

    const state = await getConversationState(db, conversation.id);
    expect(state?.mode).toBe('operator');
    expect(state?.assignedOperatorId).toBe(operator.id);
  });

  it('«подключиться» из сессии помощника гасит срок: взять себе — не значит ответить', async () => {
    const operator = await makeStaff();
    // Разговор пришёл из режима `ai`, где на нём висит живой срок «+30 минут».
    // Сохрани его захват — и через полчаса крон закрыл бы обращение, на которое
    // оператор ещё не ответил.
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });

    await claimSupportConversation(db, { conversationId: conversation.id, staffId: operator.id });

    expect((await getConversationState(db, conversation.id))?.modeExpiresAt).toBeNull();

    // И крон автозакрытия его не видит — даже когда прежний срок давно истёк.
    const ids = (await findExpiredOperatorConversations(db, { limit: 50 })).map((r) => r.conversationId);
    expect(ids).not.toContain(conversation.id);
  });

  it('служебные строки переходов не ломают append-only дух: они обычные messages с role=system', async () => {
    const conversation = await makeConversation();
    await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: 'idle',
      to: 'ai',
      trigger: 'command',
      modeExpiresAt: minutesFromNow(30),
    });

    const rows = await db.execute<{ cnt: string | number }>(
      sql`SELECT count(*) AS cnt FROM messages WHERE conversation_id = ${conversation.id} AND role = 'system'`,
    );
    expect(Number(rows[0]?.cnt ?? 0)).toBe(1);
  });
});
