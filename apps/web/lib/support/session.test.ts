import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeSupportSession,
  escalate,
  handleSupportMessage,
  openSupportSession,
  DAILY_AI_REPLY_CAP,
} from './session';
import type { ConversationSnapshot, SupportPorts, SupportHistoryRow } from './ports';
import {
  SUPPORT_CAP_REACHED,
  SUPPORT_CLOSED_BY_CLIENT,
  SUPPORT_GREETING,
  SUPPORT_GUARDED,
  SUPPORT_MEDIA_TO_AI,
  SUPPORT_MEDIA_TO_OPERATOR,
} from './texts';

/**
 * Матрица поведения помощника на шве модуля (спека «Testing Decisions» п. 1).
 *
 * Проверяем ВНЕШНЕЕ поведение: что ушло клиенту, что записалось в переписку,
 * какой режим у разговора, кого уведомили. Ни одного «функция X позвала Y».
 */

type Harness = {
  ports: SupportPorts;
  sent: { text: string; withFinishButton: boolean }[];
  appended: { role: string; content: string; meta?: Record<string, unknown> }[];
  transitions: { from: unknown; to: string; trigger: string; modeExpiresAt: Date | null }[];
  touches: { mode: string; modeExpiresAt: Date | null }[];
  events: { name: string; [k: string]: unknown }[];
  staffNotified: { trigger: string; reason: string | null }[];
  staffFollowUps: unknown[];
  snapshot: ConversationSnapshot | null;
  historyRows: SupportHistoryRow[];
  modelCalls: { role: string; content: string }[][];
};

const NOW = new Date('2026-08-27T12:00:00Z'); // 15:00 МСК — рабочее время

function harness(over: Partial<{
  snapshot: ConversationSnapshot | null;
  aiReplies: number;
  configured: boolean;
  modelReply: { text: string; toolsUsed?: string[]; requestHuman?: string } | Error;
  transitioned: boolean;
  historyRows: SupportHistoryRow[];
  staffDelivered: boolean;
  /** Когда персоналу в последний раз уходил пинг о новом сообщении клиента. */
  followUpNotifiedAt: Date | null;
}> = {}): Harness {
  const sent: Harness['sent'] = [];
  const appended: Harness['appended'] = [];
  const transitions: Harness['transitions'] = [];
  const touches: Harness['touches'] = [];
  const events: Harness['events'] = [];
  const staffNotified: Harness['staffNotified'] = [];
  const staffFollowUps: Harness['staffFollowUps'] = [];
  const modelCalls: Harness['modelCalls'] = [];

  const state: Harness['snapshot'] =
    over.snapshot === undefined
      ? { mode: 'ai', modeExpiresAt: new Date(NOW.getTime() + 600_000), assignedOperatorId: null }
      : over.snapshot;
  const historyRows = over.historyRows ?? [];

  const h: Harness = {
    sent,
    appended,
    transitions,
    touches,
    events,
    staffNotified,
    staffFollowUps,
    snapshot: state,
    historyRows,
    modelCalls,
    ports: {
      state: {
        read: async () => h.snapshot,
        transition: async (input) => {
          transitions.push({
            from: input.from,
            to: input.to,
            trigger: input.trigger,
            modeExpiresAt: input.modeExpiresAt,
          });
          // ⚠️ Двойник ОБЯЗАН уважать `from`, как условный UPDATE в БД. Пока он
          // соглашался на любой переход, тест не видел главного: у истёкшей
          // сессии в базе всё ещё `ai`, и переход `from: 'idle'` не совпал бы
          // ни с одной строкой — кнопка «Поддержка» молча не делала бы ничего.
          const allowed = Array.isArray(input.from)
            ? (input.from as readonly string[]).includes(h.snapshot?.mode ?? '')
            : h.snapshot?.mode === input.from;
          const ok = (over.transitioned ?? true) && allowed;
          if (ok && h.snapshot) {
            h.snapshot = {
              mode: input.to,
              modeExpiresAt: input.modeExpiresAt,
              assignedOperatorId: input.assignedOperatorId ?? null,
            };
          }
          return { transitioned: ok };
        },
        touch: async (mode, modeExpiresAt) => {
          touches.push({ mode, modeExpiresAt });
        },
        countAiReplies: async () => over.aiReplies ?? 0,
        history: async () => h.historyRows,
        append: async (row) => {
          appended.push(row);
        },
      },
      model: {
        configured: () => over.configured ?? true,
        reply: async (history, hooks) => {
          modelCalls.push(history);
          const r = over.modelReply ?? { text: 'Ответ помощника.' };
          // Порт тотальный: авария провайдера приходит как `null`, уже
          // записанная в лог и Sentry реализацией порта.
          if (r instanceof Error) return null;
          // Модель «позвала человека» — как это сделал бы tool `request_human`
          // внутри цикла: через хук, который модуль передал порту.
          if (r.requestHuman !== undefined) await hooks.requestHuman(r.requestHuman);
          return {
            text: r.text,
            model: 'deepseek-v4-flash',
            usage: { input_tokens: 10, output_tokens: 5 },
            toolsUsed: r.toolsUsed ?? [],
            incomplete: false,
          };
        },
      },
      delivery: {
        toClient: async (text, opts) => {
          sent.push({ text, withFinishButton: opts?.withFinishButton ?? false });
          return true;
        },
      },
      staff: {
        notifyEscalation: async (input) => {
          staffNotified.push({ trigger: input.trigger, reason: input.reason });
          return over.staffDelivered ?? true;
        },
        notifyFollowUp: async () => {
          staffFollowUps.push(true);
          return true;
        },
        lastFollowUpAt: async () => over.followUpNotifiedAt ?? null,
      },
      analytics: {
        track: (e) => {
          events.push(e as unknown as Harness['events'][number]);
        },
      },
    },
  };
  return h;
}

const idle: ConversationSnapshot = { mode: 'idle', modeExpiresAt: null, assignedOperatorId: null };
const operator: ConversationSnapshot = {
  mode: 'operator',
  modeExpiresAt: null,
  assignedOperatorId: 'staff-1',
};

beforeEach(() => vi.clearAllMocks());

describe('открытие сессии', () => {
  it('из idle: переход в помощника, приветствие с кнопкой «Завершить», событие', async () => {
    const h = harness({ snapshot: idle });
    const res = await openSupportSession(h.ports, { surface: 'button', now: NOW });

    expect(res.status).toBe('opened');
    expect(h.sent).toEqual([{ text: SUPPORT_GREETING, withFinishButton: true }]);
    expect(h.transitions[0]).toMatchObject({ to: 'ai', trigger: 'button' });
    expect(h.events).toContainEqual({ name: 'support_session_started', surface: 'button' });
  });

  it('срок сессии — 30 минут от входа', async () => {
    const h = harness({ snapshot: idle });
    await openSupportSession(h.ports, { surface: 'command', now: NOW });
    expect(h.transitions[0]?.modeExpiresAt?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  it('повторное нажатие в живой сессии не плодит приветствий — только продлевает срок', async () => {
    const h = harness();
    const res = await openSupportSession(h.ports, { surface: 'button', now: NOW });

    expect(res.status).toBe('already_open');
    expect(h.sent).toHaveLength(0);
    expect(h.touches).toHaveLength(1);
  });

  it('разговор ведёт человек — кнопка НЕ отбирает его у оператора, но и не молчит (РЕГРЕСС V9)', async () => {
    const h = harness({ snapshot: operator });
    const res = await openSupportSession(h.ports, { surface: 'button', now: NOW });

    expect(res.status).toBe('operator_leads');
    expect(h.transitions).toHaveLength(0);
    // Клиент нажал и ждёт хоть чего-то: говорим, кто ведёт и что ответ придёт сюда.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain('у оператора');
  });

  it('РЕГРЕСС V1: без ключа сессия НЕ открывается — приветствие без ответа за ним хуже флоу к человеку', async () => {
    const h = harness({ snapshot: idle, configured: false });
    const res = await openSupportSession(h.ports, { surface: 'button', now: NOW });

    expect(res.status).toBe('unavailable');
    expect(h.transitions).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('РЕГРЕСС: истёкшая сессия открывается с ПЕРВОГО нажатия', async () => {
    // В БД у истёкшей сессии по-прежнему `ai` — срок гаснет лениво. Переход
    // с условием `from: 'idle'` не совпал бы ни с одной строкой, и клиент,
    // вернувшийся через полчаса, на нажатие «Поддержка» не получал НИЧЕГО.
    const h = harness({
      snapshot: { mode: 'ai', modeExpiresAt: new Date(NOW.getTime() - 1000), assignedOperatorId: null },
    });
    const res = await openSupportSession(h.ports, { surface: 'button', now: NOW });

    expect(res.status).toBe('opened');
    expect(h.sent).toEqual([{ text: SUPPORT_GREETING, withFinishButton: true }]);
  });

  it('БД недоступна — сессию не открываем, вызывающий уводит к человеку', async () => {
    const h = harness({ snapshot: null });
    expect((await openSupportSession(h.ports, { surface: 'button', now: NOW })).status).toBe(
      'unavailable',
    );
  });
});

describe('ход помощника', () => {
  it('отвечает, пишет ответ с меткой support_ai и продлевает срок', async () => {
    const h = harness();
    const res = await handleSupportMessage(h.ports, { text: 'когда придёт карта?', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'answered' });
    expect(h.sent).toEqual([{ text: 'Ответ помощника.', withFinishButton: true }]);
    // Реплика клиента — ПЕРВОЙ и ровно одна: её пишет модуль, а не бот (V2).
    expect(h.appended[0]).toMatchObject({ role: 'user', content: 'когда придёт карта?' });
    expect(h.appended.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(h.appended[1]).toMatchObject({
      role: 'assistant',
      content: 'Ответ помощника.',
      meta: expect.objectContaining({ source: 'support_ai', model: 'deepseek-v4-flash' }),
    });
    expect(h.touches[0]?.modeExpiresAt?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
    expect(h.events).toContainEqual({ name: 'support_ai_reply', toolsUsed: 0, guarded: false });
  });

  it('текст клиента уходит модели ЗАМАСКИРОВАННЫМ', async () => {
    const h = harness();
    await handleSupportMessage(h.ports, {
      text: 'моя карта 4111111111111111, телефон +79991234567',
      kind: 'text',
      now: NOW,
    });

    const sentToModel = JSON.stringify(h.modelCalls[0]);
    expect(sentToModel).not.toContain('4111111111111111');
    expect(sentToModel).not.toContain('79991234567');
    expect(sentToModel).toContain('**** 1111');
  });

  it('история маскируется тоже — вчерашний номер карты не уезжает провайдеру', async () => {
    const h = harness({
      historyRows: [
        { role: 'user', content: 'вот карта 4111111111111111' },
        { role: 'assistant', content: 'принято' },
        { role: 'user', content: 'и что теперь' },
      ],
    });
    await handleSupportMessage(h.ports, { text: 'и что теперь', kind: 'text', now: NOW });

    expect(JSON.stringify(h.modelCalls[0])).not.toContain('4111111111111111');
  });

  it('реплики оператора подаются модели с пометкой «Оператор:»', async () => {
    const h = harness({
      historyRows: [
        { role: 'user', content: 'вопрос' },
        { role: 'operator', content: 'я разобрался, всё ок' },
        { role: 'user', content: 'спасибо' },
      ],
    });
    await handleSupportMessage(h.ports, { text: 'спасибо', kind: 'text', now: NOW });

    expect(JSON.stringify(h.modelCalls[0])).toContain('Оператор: я разобрался');
  });

  it('история начинается с реплики клиента даже когда окно срезало её начало', async () => {
    const h = harness({
      historyRows: [
        { role: 'assistant', content: 'хвост прошлого ответа' },
        { role: 'user', content: 'новый вопрос' },
      ],
    });
    await handleSupportMessage(h.ports, { text: 'новый вопрос', kind: 'text', now: NOW });

    expect(h.modelCalls[0]?.[0]?.role).toBe('user');
  });
});

describe('срок сессии', () => {
  it('истёкшая сессия хоронится и обрабатывается как idle — подсказка, а не ответ', async () => {
    const h = harness({
      snapshot: {
        mode: 'ai',
        modeExpiresAt: new Date(NOW.getTime() - 1000),
        assignedOperatorId: null,
      },
    });
    const res = await handleSupportMessage(h.ports, { text: 'ау', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'not_in_session' });
    expect(h.transitions[0]).toMatchObject({ to: 'idle', trigger: 'ttl' });
    expect(h.events).toContainEqual({ name: 'support_session_closed', reason: 'ttl' });
    expect(h.sent).toHaveLength(0);
  });

  it('истечение молчаливо: клиенту вдогонку ничего не отправляется', async () => {
    const h = harness({
      snapshot: { mode: 'ai', modeExpiresAt: new Date(NOW.getTime() - 1), assignedOperatorId: null },
    });
    await handleSupportMessage(h.ports, { text: 'ау', kind: 'text', now: NOW });
    expect(h.sent).toHaveLength(0);
  });
});

describe('режимы вне сессии помощника', () => {
  it('idle: помощник не отвечает — обращение создаёт только кнопка', async () => {
    const h = harness({ snapshot: idle });
    const res = await handleSupportMessage(h.ports, { text: 'помогите', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'not_in_session' });
    expect(h.modelCalls).toHaveLength(0);
  });

  it('operator: помощник молчит, чтобы не спорить с человеком', async () => {
    const h = harness({ snapshot: operator });
    const res = await handleSupportMessage(h.ports, { text: 'ещё вопрос', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'operator_leads' });
    expect(h.modelCalls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('БД недоступна — честный отдельный исход, а не «сессии нет»', async () => {
    const h = harness({ snapshot: null });
    expect(await handleSupportMessage(h.ports, { text: 'x', kind: 'text', now: NOW })).toEqual({
      status: 'state_unavailable',
    });
  });
});

describe('медиа', () => {
  it('в сессии помощника: честный текст и подпись вложения в переписке', async () => {
    const h = harness();
    const res = await handleSupportMessage(h.ports, {
      text: '',
      kind: 'media',
      mediaPlaceholder: '[фото]',
      now: NOW,
    });

    expect(res).toEqual({ status: 'media_rejected' });
    expect(h.sent[0]?.text).toBe(SUPPORT_MEDIA_TO_AI);
    expect(h.appended).toContainEqual({ role: 'user', content: '[фото]' });
    expect(h.modelCalls).toHaveLength(0);
  });

  it('у оператора: свой текст — человек тоже видит только переписку', async () => {
    const h = harness({ snapshot: operator });
    await handleSupportMessage(h.ports, {
      text: '',
      kind: 'media',
      mediaPlaceholder: '[файл]',
      now: NOW,
    });

    expect(h.sent[0]?.text).toBe(SUPPORT_MEDIA_TO_OPERATOR);
    // Вложение — реплика клиента, как и текст: маркер обращения, touch и
    // пинг персоналу. Иначе клиент, ответивший скриншотом, через сутки
    // закрывался бы как «молчавший», а «без ответа» его не видел бы.
    expect(h.appended).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: '[файл]',
        meta: expect.objectContaining({ support_request: true }),
      }),
    );
    expect(h.touches).toContainEqual({ mode: 'operator', modeExpiresAt: null });
  });
});

describe('суточный кап', () => {
  it('на исчерпании лимита отвечает отказом и закрывает сессию БЕЗ эскалации', async () => {
    const h = harness({ aiReplies: DAILY_AI_REPLY_CAP });
    const res = await handleSupportMessage(h.ports, { text: 'ещё', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'capped' });
    expect(h.sent[0]?.text).toBe(SUPPORT_CAP_REACHED);
    expect(h.transitions[0]).toMatchObject({ to: 'idle', trigger: 'cap' });
    expect(h.staffNotified).toHaveLength(0);
    expect(h.modelCalls).toHaveLength(0);
  });

  it('под лимитом ход проходит', async () => {
    const h = harness({ aiReplies: DAILY_AI_REPLY_CAP - 1 });
    expect(await handleSupportMessage(h.ports, { text: 'ещё', kind: 'text', now: NOW })).toEqual({
      status: 'answered',
    });
  });
});

describe('деградация помощника', () => {
  it('ключа нет — ведём себя как при выключённом флаге: сессия гаснет, клиент идёт прежним путём', async () => {
    // ⚠️ НЕ эскалация. Эскалация запирает разговор в режиме оператора, выйти из
    // которого клиент сам не может, — и одна забытая переменная окружения
    // делала бы каждого написавшего недостижимым для бота.
    const h = harness({ configured: false });
    const res = await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'not_in_session' });
    expect(h.transitions[0]).toMatchObject({ to: 'idle', trigger: 'ai_disabled' });
    expect(h.staffNotified).toHaveLength(0);
  });

  it('ключа нет — ход из суточного лимита не тратится', async () => {
    const h = harness({ configured: false });
    await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW });
    expect(h.events.filter((e) => e.name === 'support_ai_reply')).toHaveLength(0);
  });

  it('модель недоступна — эскалация, клиенту честный текст', async () => {
    const h = harness({ modelReply: new Error('503 upstream') });
    const res = await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'escalated', trigger: 'ai_unavailable' });
    expect(h.sent[0]?.text).toContain('Помощник сейчас недоступен');
  });

  it('пустой ответ модели — молчания не будет, уходит к человеку', async () => {
    const h = harness({ modelReply: { text: '   ' } });
    expect(await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW })).toEqual({
      status: 'escalated',
      trigger: 'ai_unavailable',
    });
  });
});

describe('эскалация', () => {
  it('неотвеченное обращение не гаснет: срок режима — null', async () => {
    const h = harness();
    await escalate(h.ports, { trigger: 'hard', reason: 'человек', now: NOW });
    expect(h.transitions[0]?.modeExpiresAt).toBeNull();
  });

  it('порядок: клиенту сказали ДО того, как позвали персонал', async () => {
    const order: string[] = [];
    const h = harness();
    const origSend = h.ports.delivery.toClient;
    h.ports.delivery.toClient = async (t, o) => {
      order.push('client');
      return origSend(t, o);
    };
    const origNotify = h.ports.staff.notifyEscalation;
    h.ports.staff.notifyEscalation = async (i) => {
      order.push('staff');
      return origNotify(i);
    };

    await escalate(h.ports, { trigger: 'hard', reason: null, now: NOW });
    expect(order).toEqual(['client', 'staff']);
  });

  it('маркер обращения и исход доставки пишутся в переписку — панель их читает', async () => {
    const h = harness({ staffDelivered: false });
    await escalate(h.ports, { trigger: 'model', reason: 'нужен человек', now: NOW });

    expect(h.appended[0]?.meta).toMatchObject({
      support_request: true,
      support_delivered: false,
      trigger: 'model',
    });
  });

  it('контекст оператору уходит замаскированным', async () => {
    const h = harness({ historyRows: [{ role: 'user', content: 'карта 4111111111111111' }] });
    let seen = '';
    h.ports.staff.notifyEscalation = async (i) => {
      seen = JSON.stringify(i.lastMessages);
      return true;
    };
    await escalate(h.ports, { trigger: 'hard', reason: null, now: NOW });

    expect(seen).not.toContain('4111111111111111');
  });

  it('переход не состоялся (успели раньше) — второго «передаю оператору» клиент не получит', async () => {
    const h = harness({ transitioned: false });
    await escalate(h.ports, { trigger: 'guard', reason: null, now: NOW });

    expect(h.sent).toHaveLength(0);
    expect(h.staffNotified).toHaveLength(0);
  });

  it('ночью срок ответа называется честно', async () => {
    const night = new Date('2026-08-27T00:30:00Z'); // 03:30 МСК
    const h = harness();
    await escalate(h.ports, { trigger: 'hard', reason: null, now: night });

    expect(h.sent[0]?.text).toContain('нерабочее время');
  });
});

describe('завершение сессии', () => {
  it('кнопка «Завершить»: переход в idle и прощание', async () => {
    const h = harness();
    const res = await closeSupportSession(h.ports, { reason: 'client', now: NOW });

    expect(res.closed).toBe(true);
    expect(h.sent[0]?.text).toBe(SUPPORT_CLOSED_BY_CLIENT);
    expect(h.events).toContainEqual({ name: 'support_session_closed', reason: 'client' });
  });

  it('/start закрывает молча — спорить с действием клиента не нужно', async () => {
    const h = harness();
    await closeSupportSession(h.ports, { reason: 'start', silent: true, now: NOW });

    expect(h.sent).toHaveLength(0);
    expect(h.transitions[0]).toMatchObject({ to: 'idle', trigger: 'start' });
  });

  it('/start в режиме оператора разговор НЕ закрывает', async () => {
    const h = harness({ snapshot: operator });
    const res = await closeSupportSession(h.ports, { reason: 'start', silent: true, now: NOW });

    expect(res.closed).toBe(false);
    expect(h.transitions).toHaveLength(0);
  });

  it('РЕГРЕСС: /start хоронит ИСТЁКШУЮ сессию, а не оставляет вечный ai в базе', async () => {
    // По эффективному режиму истёкшая сессия выглядит как `idle`, и закрытие
    // по нему пропускало бы её мимо: строка навсегда оставалась бы `ai`, а
    // панель показывала бы разговор у помощника, которого там нет.
    const h = harness({
      snapshot: { mode: 'ai', modeExpiresAt: new Date(NOW.getTime() - 1), assignedOperatorId: null },
    });
    const res = await closeSupportSession(h.ports, { reason: 'start', silent: true, now: NOW });

    expect(res.closed).toBe(true);
    expect(h.transitions[0]).toMatchObject({ from: 'ai', to: 'idle', trigger: 'ttl' });
  });

  it('истёкшую сессию хороним МОЛЧА даже по кнопке «Завершить»', async () => {
    const h = harness({
      snapshot: { mode: 'ai', modeExpiresAt: new Date(NOW.getTime() - 1), assignedOperatorId: null },
    });
    await closeSupportSession(h.ports, { reason: 'client', now: NOW });

    expect(h.sent).toHaveLength(0);
  });

  it('закрывать нечего (idle) — тихо ничего не делаем', async () => {
    const h = harness({ snapshot: idle });
    expect((await closeSupportSession(h.ports, { reason: 'client', now: NOW })).closed).toBe(false);
  });
});

describe('жёсткий триггер (тикет 04)', () => {
  it('«позовите оператора» уходит человеку ДО вызова модели', async () => {
    const h = harness();
    const res = await handleSupportMessage(h.ports, { text: 'позовите оператора', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'escalated', trigger: 'hard' });
    expect(h.modelCalls).toHaveLength(0);
    expect(h.transitions[0]).toMatchObject({ to: 'operator', trigger: 'hard' });
  });

  it('категория триггера уходит оператору причиной', async () => {
    const h = harness();
    await handleSupportMessage(h.ports, { text: 'хочу возврат', kind: 'text', now: NOW });

    expect(h.staffNotified[0]).toMatchObject({ trigger: 'hard' });
    expect(h.staffNotified[0]?.reason).toContain('refund');
  });

  it('ход из суточного лимита на триггер не тратится', async () => {
    const h = harness({ aiReplies: DAILY_AI_REPLY_CAP });
    // Даже при исчерпанном капе триггер срабатывает: человек важнее лимита.
    const res = await handleSupportMessage(h.ports, { text: 'это мошенники', kind: 'text', now: NOW });
    expect(res).toEqual({ status: 'escalated', trigger: 'hard' });
  });

  it('обычный вопрос триггер не задевает', async () => {
    const h = harness();
    await handleSupportMessage(h.ports, { text: 'когда придёт карта?', kind: 'text', now: NOW });
    expect(h.modelCalls).toHaveLength(1);
  });
});

describe('tool request_human (тикет 04)', () => {
  it('модель позвала человека — переход с триггером model и причиной модели', async () => {
    const h = harness({ modelReply: { text: 'Передаю оператору.', requestHuman: 'вопрос про документы' } });
    const res = await handleSupportMessage(h.ports, { text: 'нужна справка', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'escalated', trigger: 'model' });
    expect(h.transitions.find((t) => t.to === 'operator')).toMatchObject({ trigger: 'model' });
    expect(h.staffNotified[0]).toMatchObject({ trigger: 'model', reason: 'вопрос про документы' });
  });

  it('после эскалации текст модели клиенту НЕ отправляется — ему уже сказано «передаю оператору»', async () => {
    const h = harness({ modelReply: { text: 'Сейчас всё узнаю.', requestHuman: 'причина' } });
    await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW });

    const texts = h.sent.map((m) => m.text);
    expect(texts).not.toContain('Сейчас всё узнаю.');
    expect(texts.some((t) => t.startsWith('Передаю оператору'))).toBe(true);
  });

  it('повторный вызов в уже переданном разговоре не плодит уведомлений', async () => {
    const h = harness({ modelReply: { text: '', requestHuman: 'ещё раз' } });
    // Первый ход — передал.
    await handleSupportMessage(h.ports, { text: 'вопрос', kind: 'text', now: NOW });
    // Разговор теперь у оператора: второй ход модели вообще не случится.
    const res = await handleSupportMessage(h.ports, { text: 'и ещё', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'operator_leads' });
    expect(h.staffNotified).toHaveLength(1);
  });
});

describe('выходной фильтр (тикет 04)', () => {
  it('запрещённое слово в ответе: клиент видит нейтральную фразу, разговор уходит человеку', async () => {
    const h = harness({ modelReply: { text: 'Карту выпускает PaySpace, всё надёжно.' } });
    const res = await handleSupportMessage(h.ports, { text: 'кто выпускает карту?', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'escalated', trigger: 'guard' });
    const texts = h.sent.map((m) => m.text);
    expect(texts.some((t) => t.includes('PaySpace'))).toBe(false);
    expect(texts[0]).toBe(SUPPORT_GUARDED);
  });

  it('пойманный ответ НЕ записывается в переписку как ответ помощника', async () => {
    const h = harness({ modelReply: { text: 'Наша комиссия 30%.' } });
    await handleSupportMessage(h.ports, { text: 'какой процент?', kind: 'text', now: NOW });

    const aiRows = h.appended.filter((r) => r.meta?.source === 'support_ai');
    expect(aiRows).toHaveLength(0);
    // А реплика клиента — есть: её пишет модуль до любого исхода.
    expect(h.appended.some((r) => r.role === 'user')).toBe(true);
  });

  it('событие аналитики помечает ход как guarded', async () => {
    const h = harness({ modelReply: { text: 'Статус payment_review.' } });
    await handleSupportMessage(h.ports, { text: 'статус?', kind: 'text', now: NOW });

    expect(h.events).toContainEqual({ name: 'support_ai_reply', toolsUsed: 0, guarded: true });
    expect(h.events).toContainEqual({ name: 'support_escalated', trigger: 'guard' });
  });

  it('чистый ответ проходит без задержек', async () => {
    const h = harness({ modelReply: { text: 'Карта придёт в Telegram после оплаты.' } });
    expect(await handleSupportMessage(h.ports, { text: 'когда карта?', kind: 'text', now: NOW })).toEqual({
      status: 'answered',
    });
  });
});

describe('сообщение клиента в режиме оператора (тикет 04)', () => {
  it('пишется с маркером обращения, срок сбрасывается в null, персонал уведомлён', async () => {
    const h = harness({ snapshot: operator });
    const res = await handleSupportMessage(h.ports, { text: 'вы тут?', kind: 'text', now: NOW });

    expect(res).toEqual({ status: 'operator_leads' });
    expect(h.touches).toContainEqual({ mode: 'operator', modeExpiresAt: null });
    expect(h.appended).toContainEqual(
      expect.objectContaining({ role: 'user', meta: expect.objectContaining({ support_request: true }) }),
    );
    expect(h.staffFollowUps).toHaveLength(1);
  });

  it('уведомление персоналу дедупится: второе сообщение за полчаса не пингует', async () => {
    const h = harness({ snapshot: operator, followUpNotifiedAt: new Date(NOW.getTime() - 10 * 60_000) });
    await handleSupportMessage(h.ports, { text: 'ещё раз', kind: 'text', now: NOW });

    expect(h.staffFollowUps).toHaveLength(0);
  });

  it('прошло больше получаса — пингуем снова', async () => {
    const h = harness({ snapshot: operator, followUpNotifiedAt: new Date(NOW.getTime() - 31 * 60_000) });
    await handleSupportMessage(h.ports, { text: 'ау', kind: 'text', now: NOW });

    expect(h.staffFollowUps).toHaveLength(1);
  });
});
