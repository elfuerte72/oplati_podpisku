import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  notifyOpsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  env: { PHONE_REQUIRED_FROM_RUB: undefined as number | undefined },
}));

vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));
vi.mock('../env.server.ts', () => ({
  serverEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => h.env[key as keyof typeof h.env],
  }),
}));

import {
  notifyPhoneGateBlocked,
  phoneRequirementRub,
  resetPhoneGateDedupForTests,
} from './phone-gate.ts';

const ORDER = { id: 'ord-1', shortId: 'ORD-PHONE', amountRub: 1_500_000 };

beforeEach(() => {
  vi.clearAllMocks();
  resetPhoneGateDedupForTests();
  h.env.PHONE_REQUIRED_FROM_RUB = undefined;
});

describe('phone-gate (тикет 05)', () => {
  it('порог читается из env; не задан → null (фича выключена)', () => {
    expect(phoneRequirementRub()).toBeNull();
    h.env.PHONE_REQUIRED_FROM_RUB = 10_000;
    expect(phoneRequirementRub()).toBe(10_000);
  });

  it('DM оператору содержит заказ и порог; повтор по заказу — дедуп', async () => {
    await notifyPhoneGateBlocked(ORDER, 10_000);
    await notifyPhoneGateBlocked(ORDER, 10_000);

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    // Заказ и порог — строки фактов под заголовком, поэтому смотрим весь вызов.
    const sent = JSON.stringify(h.notifyOpsMock.mock.calls[0]);
    expect(sent).toContain('ORD-PHONE');
    expect(sent).toContain('10000');
  });

  it('сбой доставки DM не бросает (ответ клиенту важнее)', async () => {
    h.notifyOpsMock.mockRejectedValueOnce(new Error('telegram down'));
    await expect(notifyPhoneGateBlocked(ORDER, 10_000)).resolves.toBeUndefined();
  });
});
