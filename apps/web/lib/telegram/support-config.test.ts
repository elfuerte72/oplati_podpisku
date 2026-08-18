import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: { SUPPORT_OPERATOR_CHAT_ID: undefined as string | undefined },
  sendMessageMock: vi.fn(async () => ({})),
  // ⚠️ Доставку персоналу мокаем ЯВНО. Без мока вызов уходил в базу, падал на
  // незаданном DATABASE_URL, и тесты про legacy-канал были зелёными по
  // случайности: достаточно задать переменную окружения — и они меняют смысл,
  // ничего не сообщая (находка ревью).
  notifyStaffMock: vi.fn(async (..._args: unknown[]) => ({
    delivered: 0,
    failed: 0,
    deduped: false,
  })),
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('./bot', () => ({ getBot: () => ({ api: { sendMessage: h.sendMessageMock } }) }));
vi.mock('@/lib/alerts/notify-staff', () => ({ notifyStaff: h.notifyStaffMock }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import { sendToSupportOperator, supportOperatorChatId } from './support.ts';

describe('supportOperatorChatId (M-15: только env, без дефолта в коде)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.SUPPORT_OPERATOR_CHAT_ID = undefined;
    h.notifyStaffMock.mockResolvedValue({ delivered: 0, failed: 0, deduped: false });
  });

  it('env не задан → null (захардкоженного ID владельца больше нет)', () => {
    expect(supportOperatorChatId()).toBeNull();
  });

  it('env задан → используется он', () => {
    h.env.SUPPORT_OPERATOR_CHAT_ID = '111222333';
    expect(supportOperatorChatId()).toBe('111222333');
  });

  it('отправка без настроенного оператора → false + Sentry-алёрт, DM не шлётся', async () => {
    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(false);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('SUPPORT_OPERATOR_CHAT_ID');
  });

  it('с настроенным оператором сообщение уходит ему', async () => {
    h.env.SUPPORT_OPERATOR_CHAT_ID = '111222333';

    const ok = await sendToSupportOperator('текст');

    expect(ok).toBe(true);
    expect(h.sendMessageMock).toHaveBeenCalledWith('111222333', 'текст', { parse_mode: 'HTML' });
  });
});

describe('обращение уходит ПЕРСОНАЛУ (тикет 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.SUPPORT_OPERATOR_CHAT_ID = '111222333';
    h.notifyStaffMock.mockResolvedValue({ delivered: 1, failed: 0, deduped: false });
  });

  it('доставлено персоналу — legacy-канал НЕ дублирует', async () => {
    // Владелец заведён и в `staff`, и в переменной: без этой ветки он получал
    // бы каждое обращение дважды.
    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(true);
    expect(h.notifyStaffMock).toHaveBeenCalledWith(
      expect.stringContaining('обращение'),
      expect.objectContaining({ capability: 'support' }),
    );
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });

  it('персоналу не ушло — работает второй эшелон', async () => {
    h.notifyStaffMock.mockResolvedValue({ delivered: 0, failed: 1, deduped: false });

    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(true);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('персонал есть, а переменной нет — обращение всё равно доставлено', async () => {
    h.env.SUPPORT_OPERATOR_CHAT_ID = undefined;
    h.notifyStaffMock.mockResolvedValue({ delivered: 2, failed: 0, deduped: false });

    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(true);
    // И никакой ложной тревоги про незаданный env: доставлять было кому.
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('в текст персоналу уходит СНЯТАЯ разметка, а не сырой HTML', async () => {
    await sendToSupportOperator('<b>Клиент</b>: не проходит оплата');

    const text = String(h.notifyStaffMock.mock.calls[0]?.[0]);
    expect(text).not.toContain('<b>');
    expect(text).toContain('Клиент: не проходит оплата');
  });
});
