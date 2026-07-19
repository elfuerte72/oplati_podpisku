import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: { SUPPORT_OPERATOR_CHAT_ID: undefined as string | undefined },
  sendMessageMock: vi.fn(async () => ({})),
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('./bot', () => ({ getBot: () => ({ api: { sendMessage: h.sendMessageMock } }) }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import { sendToSupportOperator, supportOperatorChatId } from './support.ts';

describe('supportOperatorChatId (M-15: только env, без дефолта в коде)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.SUPPORT_OPERATOR_CHAT_ID = undefined;
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
