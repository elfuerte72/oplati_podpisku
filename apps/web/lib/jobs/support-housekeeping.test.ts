import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Хозяйство поддержки (тикет 06): автозакрытие и алёрт «без ответа».
 *
 * Проверяем на шве джоба с моками портов: какие разговоры закрылись, кому что
 * ушло, что дедуп и нерабочее время реально гасят пинг. Выборки БД — в
 * PGlite-тестах репозитория, здесь они подменены.
 */

const h = vi.hoisted(() => ({
  expired: [] as { conversationId: string; userId: string; telegramId: string | null }[],
  unanswered: [] as {
    conversationId: string;
    userId: string;
    telegramId: string | null;
    lastClientMessageAt: Date;
  }[],
  transitions: [] as { conversationId: string; from: unknown; to: string; trigger: string }[],
  transitioned: true,
  sent: [] as { telegramId: string; text: string }[],
  sendOk: true,
  staffNotified: [] as { text: string; dedupKey?: string }[],
  staffDelivered: 1,
  opsNotified: [] as string[],
  tracked: [] as { name: string; props?: Record<string, unknown> }[],
  withinHours: true,
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findExpiredOperatorConversations: vi.fn(async () => h.expired),
  findUnansweredSupportConversations: vi.fn(async () => h.unanswered),
  transitionConversationMode: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    h.transitions.push({
      conversationId: String(input.conversationId),
      from: input.from,
      to: String(input.to),
      trigger: String(input.trigger),
    });
    return { transitioned: h.transitioned, state: null };
  }),
  getUserTelegramId: vi.fn(async () => null),
}));
vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({
    api: {
      sendMessage: vi.fn(async (telegramId: string, text: string) => {
        if (!h.sendOk) throw new Error('403: bot was blocked by the user');
        h.sent.push({ telegramId, text });
      }),
    },
  }),
}));
vi.mock('@/lib/alerts/notify-staff', () => ({
  notifyStaff: vi.fn(async (text: string, opts: { dedupKey?: string }) => {
    h.staffNotified.push({ text, dedupKey: opts.dedupKey });
    return { delivered: h.staffDelivered, failed: 0, deduped: false };
  }),
}));
vi.mock('@/lib/alerts/notify-ops', () => ({
  notifyOps: vi.fn(async (text: string) => {
    h.opsNotified.push(text);
    return true;
  }),
}));
vi.mock('@/lib/analytics/track', () => ({
  trackServer: vi.fn((e: { name: string; props?: Record<string, unknown> }) => {
    h.tracked.push({ name: e.name, props: e.props });
  }),
}));
vi.mock('@/lib/telegram/templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telegram/templates')>();
  return { ...actual, isWithinOperatorHours: () => h.withinHours };
});

import { runSupportHousekeeping, UNANSWERED_ALERT_DEDUP_MS } from './support-housekeeping';
import { SUPPORT_CLOSED_BY_OPERATOR } from '@/lib/support/texts';

const NOW = new Date('2026-08-27T12:00:00Z');

beforeEach(() => {
  h.expired = [];
  h.unanswered = [];
  h.transitions = [];
  h.transitioned = true;
  h.sent = [];
  h.sendOk = true;
  h.staffNotified = [];
  h.staffDelivered = 1;
  h.opsNotified = [];
  h.tracked = [];
  h.withinHours = true;
  vi.clearAllMocks();
});

describe('автозакрытие', () => {
  it('разговор с истёкшим сроком закрывается через функцию переходов с триггером auto', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.closed).toBe(1);
    expect(h.transitions[0]).toMatchObject({ conversationId: 'c1', from: 'operator', to: 'idle', trigger: 'auto' });
  });

  it('клиенту уходит «оператор завершил обращение»', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];
    await runSupportHousekeeping({ now: NOW });

    expect(h.sent).toEqual([{ telegramId: '111', text: SUPPORT_CLOSED_BY_OPERATOR }]);
  });

  it('сбой доставки НЕ откатывает переход — разговор всё равно закрыт', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];
    h.sendOk = false;

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.closed).toBe(1);
    expect(h.transitions).toHaveLength(1);
  });

  it('переход не состоялся (успели раньше) — прощание не отправляется', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];
    h.transitioned = false;

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.closed).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('клиент с сайта (нет telegram) — закрываем молча, доставлять некуда', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: null }];

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.closed).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  it('событие support_session_closed{reason: auto} пишется', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];
    await runSupportHousekeeping({ now: NOW });

    expect(h.tracked).toContainEqual(
      expect.objectContaining({ name: 'support_session_closed', props: expect.objectContaining({ stage: 'auto' }) }),
    );
  });
});

describe('алёрт «без ответа»', () => {
  const waiting = {
    conversationId: 'c2',
    userId: 'u2',
    telegramId: '222',
    lastClientMessageAt: new Date(NOW.getTime() - 3 * 3_600_000),
  };

  it('в рабочее время персонал с правом support получает уведомление', async () => {
    h.unanswered = [waiting];

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.alerted).toBe(1);
    expect(h.staffNotified).toHaveLength(1);
    expect(h.staffNotified[0]?.text).toContain('без ответа');
  });

  it('ключ дедупа — по разговору, окно четыре часа', async () => {
    h.unanswered = [waiting];
    await runSupportHousekeeping({ now: NOW });

    expect(h.staffNotified[0]?.dedupKey).toContain('c2');
    expect(UNANSWERED_ALERT_DEDUP_MS).toBe(4 * 3_600_000);
  });

  it('в нерабочее время молчим — некому отвечать, и утром пинг придёт сам', async () => {
    h.unanswered = [waiting];
    h.withinHours = false;

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.alerted).toBe(0);
    expect(h.staffNotified).toHaveLength(0);
    expect(h.opsNotified).toHaveLength(0);
  });

  it('штат пуст — уведомление уходит владельцу: молчание неотличимо от тишины', async () => {
    h.unanswered = [waiting];
    h.staffDelivered = 0;

    await runSupportHousekeeping({ now: NOW });

    expect(h.opsNotified).toHaveLength(1);
    expect(h.opsNotified[0]).toContain('без ответа');
  });

  it('текст называет, сколько часов клиент ждёт', async () => {
    h.unanswered = [waiting];
    await runSupportHousekeeping({ now: NOW });

    expect(h.staffNotified[0]?.text).toMatch(/3 ч/);
  });
});

describe('устойчивость', () => {
  it('сбой одной ветки не глушит вторую', async () => {
    h.expired = [{ conversationId: 'c1', userId: 'u1', telegramId: '111' }];
    h.unanswered = [
      {
        conversationId: 'c2',
        userId: 'u2',
        telegramId: '222',
        lastClientMessageAt: new Date(NOW.getTime() - 3 * 3_600_000),
      },
    ];
    h.sendOk = false; // автозакрытие спотыкается на доставке

    const res = await runSupportHousekeeping({ now: NOW });

    expect(res.closed).toBe(1);
    expect(res.alerted).toBe(1);
  });

  it('пустые выборки — ноль работы, ноль сообщений', async () => {
    const res = await runSupportHousekeeping({ now: NOW });
    expect(res).toEqual({ closed: 0, alerted: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.staffNotified).toHaveLength(0);
  });
});
