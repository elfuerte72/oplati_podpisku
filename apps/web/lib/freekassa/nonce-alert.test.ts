import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  notifyOpsMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  captureMessageMock: vi.fn(),
}));

vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: h.captureMessageMock }));

import { FreekassaApiError, FreekassaContractError } from './errors.ts';
import {
  alertOnFreekassaNonceRejected,
  resetFreekassaNonceAlertDedupForTests,
} from './nonce-alert.ts';

/** Дословный текст провайдера — снят с прода 2026-08-15. */
const NONCE_ERR = new FreekassaApiError({
  code: 'HTTP_400',
  httpStatus: 400,
  message: 'Request with same (or bigger) nonce already exist',
});

const CTX = { path: '/orders' };

beforeEach(() => {
  vi.clearAllMocks();
  resetFreekassaNonceAlertDedupForTests();
});

describe('alertOnFreekassaNonceRejected (инцидент 2026-08-15)', () => {
  it('отказ по nonce → DM владельцу и Sentry-алёрт', async () => {
    await alertOnFreekassaNonceRejected(NONCE_ERR, CTX);

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    const text = String(h.notifyOpsMock.mock.calls[0]?.[0]);
    // Владелец должен из одного сообщения понять И что сломалось, И что делать.
    expect(text).toContain('nonce');
    expect(text).toContain('freekassa_nonce');
    expect(text).toContain('docs/incidents.md');

    expect(h.captureMessageMock).toHaveBeenCalledTimes(1);
    const opts = h.captureMessageMock.mock.calls[0]?.[1] as { tags: Record<string, string> };
    expect(opts.tags.alert).toBe('freekassa_nonce_rejected');
  });

  it('повтор в окне дедупа — Sentry да, личка нет', async () => {
    await alertOnFreekassaNonceRejected(NONCE_ERR, CTX);
    await alertOnFreekassaNonceRejected(NONCE_ERR, { path: '/orders/create' });

    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    // Sentry группирует сам — глушить его дедупом нельзя, иначе пропадёт
    // счётчик событий, по которому видно, идёт сбой или уже кончился.
    expect(h.captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it('прочие сбои шлюза не трогает: наблюдатель зовётся на КАЖДОЙ ошибке', async () => {
    await alertOnFreekassaNonceRejected(
      new FreekassaApiError({ code: 'HTTP_400', httpStatus: 400, message: 'Wrong signature' }),
      CTX,
    );
    await alertOnFreekassaNonceRejected(new FreekassaContractError(200, 'schema drift', '{}'), CTX);
    await alertOnFreekassaNonceRejected(new TypeError('fetch failed'), CTX);

    expect(h.notifyOpsMock).not.toHaveBeenCalled();
    expect(h.captureMessageMock).not.toHaveBeenCalled();
  });

  it('сбой доставки DM не бросает — путь платежа важнее алёрта', async () => {
    h.notifyOpsMock.mockRejectedValueOnce(new Error('telegram down'));
    await expect(alertOnFreekassaNonceRejected(NONCE_ERR, CTX)).resolves.toBeUndefined();
  });
});
