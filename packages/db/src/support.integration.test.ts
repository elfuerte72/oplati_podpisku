import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import {
  SUPPORT_AI_META_SOURCE,
  SUPPORT_FLOW_META_SOURCE,
  SUPPORT_FOLLOW_UP_META_SOURCE,
  SUPPORT_STATE_META_SOURCE,
} from '@oplati/types';

import * as schema from './schema.ts';
import type { DB } from './index.ts';
import { createTestDb } from './test-harness.ts';
import { appendMessage } from './repositories/messages.ts';
import {
  claimSupportConversation,
  countUnansweredSupportRequests,
  getSupportThreadForPanel,
  listSupportRequestsForPanel,
} from './repositories/panel.ts';
import {
  countSupportAiReplies,
  findLastStaffFollowUpAt,
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

    // Строки users — RAW SQL, а не drizzle insert: builder генерирует ЯВНЫЙ
    // список колонок из ТЕКУЩЕЙ schema.ts, а колонки, добавленные миграциями
    // ПОСЛЕ 0041 (первая — funnel_opt_out_at, 0042), в этой базе ещё не
    // существуют — ровно ловушка «код новый, база старая» из CLAUDE.md.
    const userRows = await legacy.db.execute<{ id: string }>(sql`
      INSERT INTO users (telegram_id)
      VALUES ('tg-legacy-ai'), ('tg-legacy-operator')
      RETURNING id
    `);
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

    // `ai → idle` — без срока. `operator` — с УНАСЛЕДОВАННЫМ сроком в сутки:
    // до миграции «подключиться» никто не отпускал, и `NULL` означал бы «ждём
    // человека — не гаснет никогда»: клиент с такой строкой при включённом
    // помощнике не получал бы ничего, пока оператор не нажмёт «Закрыть».
    const byMode = new Map(modes.map((r) => [r.handoff_mode, r.mode_expires_at]));
    expect(byMode.get('idle')).toBeNull();
    const operatorExpiry = byMode.get('operator');
    expect(operatorExpiry).not.toBeNull();
    const ms = new Date(operatorExpiry as Date | string).getTime() - Date.now();
    expect(ms).toBeGreaterThan(23 * 3_600_000);
    expect(ms).toBeLessThan(25 * 3_600_000);
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

describe('transitionConversationMode — повтор в том же режиме (РЕГРЕСС V11)', () => {
  it('второй захват тем же оператором продлевает срок, но НЕ пишет служебную строку', async () => {
    const operator = await makeStaff();
    const conversation = await makeConversation({ mode: 'operator', assignedOperatorId: operator.id });
    const claim = (expiresAt: Date) =>
      transitionConversationMode(db, {
        conversationId: conversation.id,
        from: ['idle', 'ai', 'operator'],
        to: 'operator',
        trigger: 'operator_reply',
        modeExpiresAt: expiresAt,
        assignedOperatorId: operator.id,
        onlyIfFreeOrOwnedBy: operator.id,
      });

    // Первый ответ — уже в operator с тем же ведущим: тоже touch.
    const first = await claim(minutesFromNow(60));
    const later = minutesFromNow(24 * 60);
    const second = await claim(later);

    expect(first.transitioned).toBe(true);
    expect(second).toMatchObject({ transitioned: true, touched: true });
    expect((await getConversationState(db, conversation.id))?.modeExpiresAt?.getTime()).toBe(later.getTime());
    // Три ответа оператора подряд не должны рисовать три «→ operator» в ленте.
    expect(await systemRows(conversation.id)).toHaveLength(0);
  });

  it('touch чужого разговора отвергается: onlyIfFreeOrOwnedBy действует и без assignedOperatorId', async () => {
    // Без `assignedOperatorId` во входе `sameOwner` считался истинным, и touch
    // продлевал срок чужого разговора — тот самый, который условный UPDATE
    // ниже отверг бы.
    const owner = await makeStaff();
    const other = await makeStaff();
    const conversation = await makeConversation({
      mode: 'operator',
      assignedOperatorId: owner.id,
      modeExpiresAt: minutesFromNow(60),
    });

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: ['idle', 'ai', 'operator'],
      to: 'operator',
      trigger: 'operator_reply',
      modeExpiresAt: minutesFromNow(24 * 60),
      onlyIfFreeOrOwnedBy: other.id,
    });

    expect(res.transitioned).toBe(false);
    expect(res.touched).toBeFalsy();
    const state = await getConversationState(db, conversation.id);
    expect(state?.assignedOperatorId).toBe(owner.id);
    expect(state?.modeExpiresAt?.getTime()).toBeLessThan(minutesFromNow(120).getTime());
  });

  it('смена ведущего — это переход, а не touch: служебная строка пишется', async () => {
    const conversation = await makeConversation({ mode: 'ai', modeExpiresAt: minutesFromNow(30) });
    const operator = await makeStaff();

    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: ['idle', 'ai', 'operator'],
      to: 'operator',
      trigger: 'operator_reply',
      modeExpiresAt: minutesFromNow(24 * 60),
      assignedOperatorId: operator.id,
      onlyIfFreeOrOwnedBy: operator.id,
    });

    expect(res).toMatchObject({ transitioned: true });
    expect(res.touched).toBeFalsy();
    expect(await systemRows(conversation.id)).toHaveLength(1);
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
    // Маркер обращения — ТОТ ЖЕ предикат, что у панели: иначе бейдж «без
    // ответа» и пинг крона считались бы по разным правилам.
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'помогите',
      meta: { support_request: true },
    });
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
      meta: { support_request: true },
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
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'ещё вопрос',
      meta: { support_request: true },
    });

    const ids = (await findUnansweredSupportConversations(db, { olderThan: hoursAgo(2), limit: 50 })).map(
      (r) => r.conversationId,
    );
    expect(ids).not.toContain(conversation.id);
  });

  it('«без ответа»: реплика БЕЗ маркера обращения не считается — как и в панели (РЕГРЕСС V14)', async () => {
    const conversation = await makeConversation({ mode: 'operator', modeExpiresAt: null });
    const row = await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'просто текст' });
    await db.update(schema.messages).set({ createdAt: hoursAgo(5) }).where(eq(schema.messages.id, row.id));

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
      meta: { support_request: true },
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
    // Ответ на реферальную ссылку (2026-09-05) — тоже маскот на «ты».
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Вижу, ты по приглашению друга',
      meta: { source: 'referral_feedback' },
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

describe('findLastStaffFollowUpAt (дедуп пингов персоналу)', () => {
  it('пингов не было — null', async () => {
    const conversation = await makeConversation({ mode: 'operator' });
    expect(await findLastStaffFollowUpAt(db, conversation.id)).toBeNull();
  });

  it('возвращает время ПОСЛЕДНЕГО пинга, не первого', async () => {
    const conversation = await makeConversation({ mode: 'operator' });
    const first = new Date('2026-08-27T10:00:00Z');
    const second = new Date('2026-08-27T11:00:00Z');
    for (const at of [first, second]) {
      const row = await appendMessage(db, {
        conversationId: conversation.id,
        role: 'assistant',
        content: '[персонал уведомлён]',
        meta: { source: 'support_follow_up_ping', staff_pinged_at: at.toISOString() },
      });
      await db.update(schema.messages).set({ createdAt: at }).where(eq(schema.messages.id, row.id));
    }

    expect((await findLastStaffFollowUpAt(db, conversation.id))?.getTime()).toBe(second.getTime());
  });

  it('пинг чужого разговора не считается', async () => {
    const mine = await makeConversation({ mode: 'operator' });
    const alien = await makeConversation({ mode: 'operator' });
    await appendMessage(db, {
      conversationId: alien.id,
      role: 'assistant',
      content: '[персонал уведомлён]',
      meta: { source: 'support_follow_up_ping', staff_pinged_at: new Date().toISOString() },
    });

    expect(await findLastStaffFollowUpAt(db, mine.id)).toBeNull();
  });

  it('строка пинга в контекст помощника не попадает', async () => {
    const conversation = await makeConversation({ mode: 'ai' });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '[персонал уведомлён]',
      meta: { source: 'support_follow_up_ping', staff_pinged_at: new Date().toISOString() },
    });
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'вопрос' });

    const history = await loadSupportHistory(db, { conversationId: conversation.id, limit: 20 });
    expect(history.map((r) => r.content)).toEqual(['вопрос']);
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
    // Единый писатель режима: захват оставляет след, как любой переход (V12).
    expect(await systemRows(conversation.id)).toHaveLength(1);
  });

  it('«подключиться» к чужому — taken, к несуществующему — not_found', async () => {
    const first = await makeStaff();
    const second = await makeStaff();
    const conversation = await makeConversation({ mode: 'operator', assignedOperatorId: first.id });

    expect(await claimSupportConversation(db, { conversationId: conversation.id, staffId: second.id })).toBe('taken');
    expect(
      await claimSupportConversation(db, { conversationId: '00000000-0000-0000-0000-000000000000', staffId: second.id }),
    ).toBe('not_found');
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

/**
 * Одно правило «обращение ждёт человека» на список, счётчик меню и сторожа
 * крона (crm-serious-fixes, тикет 03).
 *
 * Весь поток прода — обращения флоу без режима (`source = 'support'`,
 * помощник выключен). До тикета их нечем было снять, кроме доставленного
 * ответа: «Подключиться» → «Закрыть» сообщало клиенту о завершении, а «+1»
 * висело бессрочно; сторож «без ответа > 2 ч» требовал режим `operator` и не
 * видел ни одного такого обращения. Теперь обращение снимает ответ оператора
 * ИЛИ закрытие/возврат помощнику ПОЗЖЕ последнего маркера — и это условие одно.
 */
describe('одно правило «ждёт человека» (тикет 03)', () => {
  const base = Date.now() - 5 * 3_600_000;
  /** Момент сценария: минуты от начала. Время задаём явно — INSERT'ы подряд ложатся в одну отметку. */
  const t = (minutes: number) => new Date(base + minutes * 60_000);

  async function setAt(messageId: string, at: Date) {
    await db.update(schema.messages).set({ createdAt: at }).where(eq(schema.messages.id, messageId));
  }

  /** Служебная строка перехода с этим триггером — в нужный момент. */
  async function setTransitionAt(conversationId: string, trigger: string, at: Date) {
    await db.execute(sql`
      UPDATE messages SET created_at = ${at.toISOString()}
       WHERE conversation_id = ${conversationId}
         AND role = 'system'
         AND meta ->> 'trigger' = ${trigger}
    `);
  }

  /** Обращение двухшагового флоу бота при выключенном помощнике: режим не меняется. */
  async function legacyRequest(conversationId: string, at: Date) {
    const row = await appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: 'Обращение отправлено',
      meta: { source: SUPPORT_FLOW_META_SOURCE, support_request: true, support_delivered: true },
    });
    await setAt(row.id, at);
  }

  /** Эскалация помощника: переход к человеку + маркер на строке эскалации. */
  async function escalation(conversationId: string, at: Date) {
    await transitionConversationMode(db, {
      conversationId,
      from: ['idle', 'ai'],
      to: 'operator',
      trigger: 'hard',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    await setTransitionAt(conversationId, 'hard', at);
    const row = await appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: 'Передаю оператору',
      meta: { source: 'support_escalation', support_request: true, support_delivered: true },
    });
    await setAt(row.id, at);
  }

  async function operatorReply(conversationId: string, staffId: string, at: Date) {
    await transitionConversationMode(db, {
      conversationId,
      from: ['idle', 'ai', 'operator'],
      to: 'operator',
      trigger: 'operator_reply',
      modeExpiresAt: minutesFromNow(24 * 60),
      assignedOperatorId: staffId,
      onlyIfFreeOrOwnedBy: staffId,
    });
    await setTransitionAt(conversationId, 'operator_reply', at);
    const row = await appendMessage(db, { conversationId, role: 'operator', content: 'разбираюсь', staffId });
    await setAt(row.id, at);
  }

  async function claim(conversationId: string, staffId: string, at: Date) {
    expect(await claimSupportConversation(db, { conversationId, staffId })).toBe('claimed');
    await setTransitionAt(conversationId, 'operator_claim', at);
  }

  /** «Закрыть» из панели — тот же переход, что делает роут. */
  async function close(conversationId: string, at: Date) {
    const res = await transitionConversationMode(db, {
      conversationId,
      from: 'operator',
      to: 'idle',
      trigger: 'operator_close',
      actorName: 'Оператор',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    expect(res.transitioned).toBe(true);
    await setTransitionAt(conversationId, 'operator_close', at);
  }

  /** «Вернуть помощнику» из панели. */
  async function returnToAi(conversationId: string, at: Date) {
    const res = await transitionConversationMode(db, {
      conversationId,
      from: 'operator',
      to: 'ai',
      trigger: 'operator_return',
      modeExpiresAt: minutesFromNow(30),
      assignedOperatorId: null,
    });
    expect(res.transitioned).toBe(true);
    await setTransitionAt(conversationId, 'operator_return', at);
  }

  /** Реплика клиента в разговоре у оператора — как пишет её модуль поддержки. */
  async function followUp(conversationId: string, at: Date) {
    await touchConversationMode(db, { conversationId, mode: 'operator', modeExpiresAt: null });
    const row = await appendMessage(db, {
      conversationId,
      role: 'user',
      content: 'заказ 1234, деньги списали',
      meta: { support_request: true, source: SUPPORT_FOLLOW_UP_META_SOURCE },
    });
    await setAt(row.id, at);
  }

  async function cronIds(olderThan: Date): Promise<string[]> {
    return (await findUnansweredSupportConversations(db, { olderThan, limit: 10_000 })).map(
      (r) => r.conversationId,
    );
  }

  it('список, счётчик и сторож отвечают ОДИНАКОВО на каждом сценарии', async () => {
    const staff = await makeStaff();
    const user = await makeUser();
    const countBefore = await countUnansweredSupportRequests(db);

    const scenarios: { name: string; awaiting: boolean; build: (id: string) => Promise<void> }[] = [
      { name: 'флоу без режима, ответа нет', awaiting: true, build: (id) => legacyRequest(id, t(0)) },
      {
        name: 'флоу без режима: «Подключиться» → «Закрыть»',
        awaiting: false,
        build: async (id) => {
          await legacyRequest(id, t(0));
          await claim(id, staff.id, t(1));
          await close(id, t(2));
        },
      },
      {
        name: 'флоу без режима: «Подключиться» без закрытия — ещё ждёт',
        awaiting: true,
        build: async (id) => {
          await legacyRequest(id, t(0));
          await claim(id, staff.id, t(1));
        },
      },
      {
        name: 'флоу без режима: закрыли, клиент обратился снова',
        awaiting: true,
        build: async (id) => {
          await legacyRequest(id, t(0));
          await claim(id, staff.id, t(1));
          await close(id, t(2));
          await legacyRequest(id, t(3));
        },
      },
      {
        name: 'флоу без режима: оператор ответил',
        awaiting: false,
        build: async (id) => {
          await legacyRequest(id, t(0));
          await operatorReply(id, staff.id, t(1));
        },
      },
      { name: 'эскалация, ответа нет', awaiting: true, build: (id) => escalation(id, t(0)) },
      {
        name: 'эскалация: «Закрыть» без ответа',
        awaiting: false,
        build: async (id) => {
          await escalation(id, t(0));
          await close(id, t(1));
        },
      },
      {
        name: 'эскалация: «Вернуть помощнику»',
        awaiting: false,
        build: async (id) => {
          await escalation(id, t(0));
          await returnToAi(id, t(1));
        },
      },
      {
        name: 'оператор ответил, клиент ответил ему',
        awaiting: true,
        build: async (id) => {
          await legacyRequest(id, t(0));
          await operatorReply(id, staff.id, t(1));
          await followUp(id, t(2));
        },
      },
    ];

    const expected = new Map<string, { name: string; awaiting: boolean }>();
    for (const scenario of scenarios) {
      const conversation = await makeConversation({ userId: user.id });
      await scenario.build(conversation.id);
      expected.set(conversation.id, { name: scenario.name, awaiting: scenario.awaiting });
    }

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id, limit: 50 });
    const cron = new Set(await cronIds(minutesFromNow(1)));
    for (const [conversationId, { name, awaiting }] of expected) {
      const row = items.find((i) => i.conversationId === conversationId);
      expect({ name, list: row?.awaitingOperator }).toEqual({ name, list: awaiting });
      expect({ name, cron: cron.has(conversationId) }).toEqual({ name, cron: awaiting });
    }
    const awaitingCount = [...expected.values()].filter((e) => e.awaiting).length;
    expect(await countUnansweredSupportRequests(db)).toBe(countBefore + awaitingCount);
  });

  it('«Подключиться» → «Закрыть» у обращения флоу без режима гасит счётчик сразу', async () => {
    const staff = await makeStaff();
    const conversation = await makeConversation();
    const before = await countUnansweredSupportRequests(db);

    await legacyRequest(conversation.id, t(0));
    expect(await countUnansweredSupportRequests(db)).toBe(before + 1);

    await claim(conversation.id, staff.id, t(1));
    expect(await countUnansweredSupportRequests(db)).toBe(before + 1);

    await close(conversation.id, t(2));
    expect(await countUnansweredSupportRequests(db)).toBe(before);
  });

  it('сторож видит обращение флоу без режима старше двух часов — разговор в idle', async () => {
    const conversation = await makeConversation();
    await legacyRequest(conversation.id, hoursAgo(3));

    expect((await getConversationState(db, conversation.id))?.mode).toBe('idle');
    expect(await cronIds(hoursAgo(2))).toContain(conversation.id);
  });

  it('сторож не видит обращение флоу без режима моложе порога', async () => {
    const conversation = await makeConversation();
    await legacyRequest(conversation.id, minutesFromNow(-30));

    expect(await cronIds(hoursAgo(2))).not.toContain(conversation.id);
  });

  it('маркер в сессии помощника обращением к человеку не считается — ни в списке, ни у сторожа', async () => {
    const user = await makeUser();
    const conversation = await makeConversation({
      mode: 'ai',
      modeExpiresAt: minutesFromNow(30),
      userId: user.id,
    });
    const row = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'вопрос',
      meta: { support_request: true },
    });
    await setAt(row.id, hoursAgo(3));

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });
    expect(items.find((i) => i.conversationId === conversation.id)?.awaitingOperator).toBe(false);
    expect(await cronIds(hoursAgo(2))).not.toContain(conversation.id);
  });
});

/**
 * Ответ клиента оператору при выключенном помощнике (crm-serious-fixes,
 * тикет 01) — то, что пишет модуль поддержки, глазами панели и крона.
 */
describe('реплика клиента после ответа оператора (тикет 01)', () => {
  it('разговор снова «без ответа», срок снят — крон его не закроет', async () => {
    const staff = await makeStaff();
    const user = await makeUser();
    // Оператор ответил больше суток назад: срок режима уже истёк.
    const conversation = await makeConversation({
      mode: 'operator',
      modeExpiresAt: hoursAgo(1),
      assignedOperatorId: staff.id,
      userId: user.id,
    });
    const reply = await appendMessage(db, {
      conversationId: conversation.id,
      role: 'operator',
      content: 'Уточните номер заказа',
      staffId: staff.id,
    });
    await db
      .update(schema.messages)
      .set({ createdAt: hoursAgo(26) })
      .where(eq(schema.messages.id, reply.id));
    const before = await countUnansweredSupportRequests(db);

    // Модуль: touch `operator` со сроком null + реплика с маркером.
    await touchConversationMode(db, {
      conversationId: conversation.id,
      mode: 'operator',
      modeExpiresAt: null,
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'user',
      content: 'заказ 1234, деньги списали',
      meta: { support_request: true, source: SUPPORT_FOLLOW_UP_META_SOURCE },
    });

    const expired = (await findExpiredOperatorConversations(db, { limit: 10_000 })).map(
      (r) => r.conversationId,
    );
    expect(expired).not.toContain(conversation.id);

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });
    const row = items.find((i) => i.conversationId === conversation.id);
    expect(row?.awaitingOperator).toBe(true);
    expect(row?.lastOperatorReplyAt).toBeNull();
    expect(await countUnansweredSupportRequests(db)).toBe(before + 1);
  });

  it('ai → operator при недоступном помощнике: обращение видно, срок null', async () => {
    const user = await makeUser();
    const conversation = await makeConversation({
      mode: 'ai',
      modeExpiresAt: minutesFromNow(20),
      userId: user.id,
    });

    // Как пишет модуль: реплика клиента, затем `escalate('ai_unavailable')` —
    // переход и строка эскалации с маркером обращения.
    await appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'где карта?' });
    const res = await transitionConversationMode(db, {
      conversationId: conversation.id,
      from: ['idle', 'ai'],
      to: 'operator',
      trigger: 'ai_unavailable',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    expect(res.transitioned).toBe(true);
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Помощник сейчас недоступен — передаю оператору.',
      meta: {
        source: 'support_escalation',
        trigger: 'ai_unavailable',
        support_request: true,
        support_delivered: true,
      },
    });

    expect(await getConversationState(db, conversation.id)).toMatchObject({
      mode: 'operator',
      modeExpiresAt: null,
    });
    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });
    expect(items.find((i) => i.conversationId === conversation.id)?.awaitingOperator).toBe(true);
  });
});

describe('срок режима в панели (тикет 03, SUP-13)', () => {
  it('список и лента отдают срок режима — экран отличит истёкшего помощника от живого', async () => {
    const user = await makeUser();
    const expiresAt = hoursAgo(1);
    const conversation = await makeConversation({
      mode: 'ai',
      modeExpiresAt: expiresAt,
      userId: user.id,
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Передали в поддержку',
      meta: { source: SUPPORT_FLOW_META_SOURCE, support_request: true },
    });

    const { items } = await listSupportRequestsForPanel(db, { userId: user.id });
    expect(items.find((i) => i.conversationId === conversation.id)?.modeExpiresAt?.getTime()).toBe(
      expiresAt.getTime(),
    );
    const thread = await getSupportThreadForPanel(db, conversation.id);
    expect(thread?.modeExpiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});
