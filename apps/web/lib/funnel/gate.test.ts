import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Привратник воронки (тикет 01). Шов — модуль воронки целиком: БД и транспорт
 * Telegram подменяются на границе, ассертится внешнее поведение («дано
 * состояние БД и время → ушло/не ушло, claim занят/нет»), а не внутренний
 * порядок приватных вызовов.
 */

const { FakeGrammyError } = vi.hoisted(() => {
  class FakeGrammyError extends Error {
    error_code: number;
    constructor(code: number) {
      super(`grammy ${code}`);
      this.error_code = code;
    }
  }
  return { FakeGrammyError };
});

const h = vi.hoisted(() => ({
  env: { RETENTION_FUNNEL_ENABLED: true },
  state: {
    user: { telegramId: '123456789012345', funnelOptOutAt: null } as {
      telegramId: string | null;
      funnelOptOutAt: Date | null;
    } | null,
    operatorActive: false,
    sends24h: 0,
    sends7d: 0,
    lastRatingAt: null as Date | null,
    claim: true,
  },
  claimMock: vi.fn(async () => h.state.claim),
  sendMessageMock: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
  buildMock: vi.fn(async () => ({ text: 'msg' })),
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('grammy', () => ({ GrammyError: FakeGrammyError, InlineKeyboard: class {} }));
vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getFunnelUserState: vi.fn(async () => h.state.user),
  hasActiveOperatorConversation: vi.fn(async () => h.state.operatorActive),
  countFunnelSendsSince: vi.fn(async (_db: unknown, _userId: string, since: Date) => {
    // Скользящие окна: короткое (сутки) и длинное (неделя) различаем по
    // расстоянию since от ЗАМОРОЖЕННОГО опорного времени тестов, а не от
    // живого Date.now(): реальные часы уезжают от 2026-09-01 с каждым днём,
    // и через сутки после мержа суточный вызов классифицировался бы как
    // недельный — красный тест на main и заблокированный гейт деплоя
    // (находка оси E full-review).
    const REF = Date.parse('2026-09-01T09:00:00Z'); // = DAY_NOON_MSK
    const ageMs = REF - since.getTime();
    return ageMs < 2 * 24 * 60 * 60 * 1000 ? h.state.sends24h : h.state.sends7d;
  }),
  getLastFunnelSendAt: vi.fn(async () => h.state.lastRatingAt),
  claimFunnelSend: h.claimMock,
}));

import { sendFunnelMessage } from './gate.ts';

// 12:00 МСК (09:00 UTC) — активные часы; 23:00 МСК (20:00 UTC) — тихое окно.
const DAY_NOON_MSK = new Date('2026-09-01T09:00:00Z');
const NIGHT_MSK = new Date('2026-09-01T20:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function send(overrides: Partial<Parameters<typeof sendFunnelMessage>[0]> = {}) {
  return sendFunnelMessage({
    userId: 'u1',
    kind: 'expired_survey',
    build: h.buildMock,
    now: DAY_NOON_MSK,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.RETENTION_FUNNEL_ENABLED = true;
  h.state.user = { telegramId: '123456789012345', funnelOptOutAt: null };
  h.state.operatorActive = false;
  h.state.sends24h = 0;
  h.state.sends7d = 0;
  h.state.lastRatingAt = null;
  h.state.claim = true;
});

describe('sendFunnelMessage — отказы привратника', () => {
  it('счастливый путь: claim занят ДО отправки, сообщение ушло строковым chat_id', async () => {
    const res = await send();

    expect(res).toEqual({ ok: true });
    expect(h.claimMock).toHaveBeenCalledTimes(1);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(h.claimMock.mock.invocationCallOrder[0]!).toBeLessThan(
      h.sendMessageMock.mock.invocationCallOrder[0]!,
    );
    const chatId = h.sendMessageMock.mock.calls[0]![0];
    expect(chatId).toBe('123456789012345');
    expect(typeof chatId).toBe('string');
  });

  it('флаг выключен → disabled, ни claim, ни отправки, ни построения контента', async () => {
    h.env.RETENTION_FUNNEL_ENABLED = false;
    const res = await send();
    expect(res).toEqual({ ok: false, reason: 'disabled' });
    expect(h.claimMock).not.toHaveBeenCalled();
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    expect(h.buildMock).not.toHaveBeenCalled();
  });

  it('нет telegram-идентичности → no_telegram', async () => {
    h.state.user = { telegramId: null, funnelOptOutAt: null };
    expect(await send()).toEqual({ ok: false, reason: 'no_telegram' });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('opt-out глушит всё', async () => {
    h.state.user = { telegramId: '1', funnelOptOutAt: new Date() };
    expect(await send()).toEqual({ ok: false, reason: 'opted_out' });
    expect(h.claimMock).not.toHaveBeenCalled();
  });

  it('разговор в режиме оператора → operator_active', async () => {
    h.state.operatorActive = true;
    expect(await send()).toEqual({ ok: false, reason: 'operator_active' });
  });

  it('тихое окно 22:00–10:00 МСК → quiet_hours, claim НЕ занимается (сообщение не сгорает)', async () => {
    const res = await send({ now: NIGHT_MSK });
    expect(res).toEqual({ ok: false, reason: 'quiet_hours' });
    expect(h.claimMock).not.toHaveBeenCalled();
  });

  it('бюджет: одно сообщение за сутки уже ушло → budget_daily', async () => {
    h.state.sends24h = 1;
    h.state.sends7d = 1;
    expect(await send()).toEqual({ ok: false, reason: 'budget_daily' });
  });

  it('бюджет: три за неделю → budget_weekly (суточное окно свободно)', async () => {
    h.state.sends24h = 0;
    h.state.sends7d = 3;
    expect(await send()).toEqual({ ok: false, reason: 'budget_weekly' });
  });

  it('order_rating: предыдущая оценка 30 дней назад → rating_too_soon', async () => {
    h.state.lastRatingAt = new Date(DAY_NOON_MSK.getTime() - 30 * DAY_MS);
    const res = await send({ kind: 'order_rating', orderId: 'o1' });
    expect(res).toEqual({ ok: false, reason: 'rating_too_soon' });
    expect(h.claimMock).not.toHaveBeenCalled();
  });

  it('order_rating: предыдущая 91 день назад → пускается', async () => {
    h.state.lastRatingAt = new Date(DAY_NOON_MSK.getTime() - 91 * DAY_MS);
    const res = await send({ kind: 'order_rating', orderId: 'o1' });
    expect(res).toEqual({ ok: true });
  });

  it('90-дневное правило не трогает другие kind', async () => {
    h.state.lastRatingAt = new Date(DAY_NOON_MSK.getTime() - DAY_MS);
    expect(await send({ kind: 'start_survey' })).toEqual({ ok: true });
  });

  it('claim занял конкурент → already_claimed, отправки нет', async () => {
    h.state.claim = false;
    expect(await send()).toEqual({ ok: false, reason: 'already_claimed' });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('403 (клиент заблокировал бота) → blocked, без throw и без Sentry', async () => {
    const sentry = await import('@sentry/nextjs');
    h.sendMessageMock.mockRejectedValueOnce(new FakeGrammyError(403));

    expect(await send()).toEqual({ ok: false, reason: 'blocked' });
    expect(vi.mocked(sentry.captureException)).not.toHaveBeenCalled();
  });

  it('прочий сбой отправки → send_failed + Sentry', async () => {
    const sentry = await import('@sentry/nextjs');
    h.sendMessageMock.mockRejectedValueOnce(new Error('network'));

    expect(await send()).toEqual({ ok: false, reason: 'send_failed' });
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1);
  });
});
