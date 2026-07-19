import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {
    LOVEANDPAY_PROXY_URL: undefined as string | undefined,
    LOVEANDPAY_BASE_URL: 'https://api.loveandpay.io/api/v1',
  },
  notifyOpsMock: vi.fn(async () => {}),
}));

vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../alerts/notify-ops.ts', () => ({ notifyOps: h.notifyOpsMock }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import { alertOnLoveAndPayProxyDown, resetProxyAlertDedupForTests } from './proxy-health.ts';

function okFetch(status = 403): typeof fetch {
  // Любой HTTP-статус означает, что CONNECT через прокси прошёл — даже 403 от
  // самого L&P говорит «сеть жива».
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

function downFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 177.7.34.106:24128');
  }) as unknown as typeof fetch;
}

function hangingFetch(): typeof fetch {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  ) as unknown as typeof fetch;
}

describe('alertOnLoveAndPayProxyDown (H-3: SPOF-мониторинг squid-прокси)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProxyAlertDedupForTests();
    h.env.LOVEANDPAY_PROXY_URL = 'http://user:secret@177.7.34.106:24128';
  });

  it('LOVEANDPAY_PROXY_URL не задан → no-op (dev/тесты ходят напрямую)', async () => {
    h.env.LOVEANDPAY_PROXY_URL = undefined;
    const fetchImpl = okFetch();

    await alertOnLoveAndPayProxyDown({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
  });

  it('прокси отвечает (любой HTTP-статус, даже 403) → алёртов нет', async () => {
    await alertOnLoveAndPayProxyDown({ fetchImpl: okFetch(403) });

    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
  });

  it('редиректы НЕ follow-ятся: redirect manual + 3xx = прокси жив (регресс 2026-07-19)', async () => {
    // Реальный кейс: origin L&P стал отвечать 307 → цепочка редиректов →
    // fetch с follow бросал «redirect count exceeded» → ложный «прокси лежит»
    // всю ночь при живом VPS. Сам 3xx-ответ ПРИШЁЛ через прокси = транспорт жив.
    const fetchImpl = okFetch(307);

    await alertOnLoveAndPayProxyDown({ fetchImpl });

    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(h.notifyOpsMock).not.toHaveBeenCalled();
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect(init?.redirect).toBe('manual');
  });

  it('прокси лежит (сетевая ошибка) → Sentry-алёрт + DM владельцу, без секретов прокси', async () => {
    await alertOnLoveAndPayProxyDown({ fetchImpl: downFetch() });

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sentry.captureMessage.mock.calls[0] as [
      string,
      { level?: string; extra?: Record<string, unknown> },
    ];
    expect(message).toContain('прокси');
    expect(options.level).toBe('error');
    // Credentials из URL не должны утечь ни в extra, ни в DM.
    expect(JSON.stringify(options.extra)).not.toContain('secret');
    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
    expect(String(h.notifyOpsMock.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it('повторное падение в окне дедупа → Sentry снова, DM — только один раз', async () => {
    await alertOnLoveAndPayProxyDown({ fetchImpl: downFetch() });
    await alertOnLoveAndPayProxyDown({ fetchImpl: downFetch() });

    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(h.notifyOpsMock).toHaveBeenCalledTimes(1);
  });

  it('зависший CONNECT → таймаут → алёрт (fetch с AbortController)', async () => {
    await alertOnLoveAndPayProxyDown({ fetchImpl: hangingFetch(), timeoutMs: 20 });

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('сбой самого мониторинга не бросает наружу (не роняет cron)', async () => {
    const brokenFetch = vi.fn(() => {
      throw new TypeError('sync explosion');
    }) as unknown as typeof fetch;

    await expect(alertOnLoveAndPayProxyDown({ fetchImpl: brokenFetch })).resolves.toBeUndefined();
  });
});
