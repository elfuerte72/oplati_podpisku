import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Диспетчер уведомлений об оплате: клиентское и персоналу идут из одного
 * `after()`, и падение первого не должно глушить второе — иначе сбой Bot API
 * у клиента оставлял бы тему «Платежи» без записи о принятых деньгах.
 */

const h = vi.hoisted(() => ({
  scheduled: [] as Array<() => Promise<void>>,
  clientMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  opsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  issueCardMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  captureMock: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void>) => {
    h.scheduled.push(cb);
  },
}));
vi.mock('./notify-payment.ts', () => ({ notifyPaymentConfirmed: h.clientMock }));
vi.mock('./notify-payment-ops.ts', () => ({ notifyPaymentOps: h.opsMock }));
vi.mock('./issue-card.ts', () => ({ issueCard: h.issueCardMock }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureMock }));

import { dispatchPaymentConfirmed } from './dispatcher.ts';

async function runScheduled(): Promise<void> {
  const cbs = h.scheduled.splice(0);
  for (const cb of cbs) await cb();
}

describe('dispatchPaymentConfirmed', () => {
  beforeEach(() => {
    h.scheduled.length = 0;
    h.clientMock.mockReset().mockResolvedValue(undefined);
    h.opsMock.mockReset().mockResolvedValue(undefined);
    h.captureMock.mockClear();
  });

  it('после ответа зовёт и клиентское уведомление, и «Оплата принята» персоналу', async () => {
    dispatchPaymentConfirmed('order-1');
    expect(h.clientMock).not.toHaveBeenCalled();
    await runScheduled();
    expect(h.clientMock).toHaveBeenCalledWith('order-1');
    expect(h.opsMock).toHaveBeenCalledWith('order-1');
    expect(h.captureMock).not.toHaveBeenCalled();
  });

  it('сбой клиентского уведомления не отменяет уведомление персоналу', async () => {
    h.clientMock.mockRejectedValueOnce(new Error('bot api down'));
    dispatchPaymentConfirmed('order-2');
    await runScheduled();
    expect(h.opsMock).toHaveBeenCalledWith('order-2');
    expect(h.captureMock).toHaveBeenCalledTimes(1);
  });

  it('сбой уведомления персоналу ловится и уходит в Sentry, клиентское уже отправлено', async () => {
    h.opsMock.mockRejectedValueOnce(new Error('group down'));
    dispatchPaymentConfirmed('order-3');
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(h.clientMock).toHaveBeenCalledWith('order-3');
    expect(h.captureMock).toHaveBeenCalledTimes(1);
  });
});
