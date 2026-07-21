import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createRemnawaveClient, remnawaveUsername } from './client.ts';
import { RemnawaveApiError, RemnawaveContractError } from './errors.ts';

const silentLogger = pino({ level: 'silent' });

function makeResp(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>, trafficLimitBytes = 0) {
  return createRemnawaveClient({
    token: 'test_token',
    baseUrl: 'https://panel.test/api',
    squadUuid: 'e819a231-6e10-46c6-8411-7001dd67e9e1',
    trafficLimitBytes,
    logger: silentLogger,
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

/** Сокращённый живой ответ панели (2026-07-21). */
function panelUser(over: Record<string, unknown> = {}) {
  return {
    uuid: '11111111-2222-4333-8444-555555555555',
    shortUuid: 'TESTshortUuid001',
    username: 'tg_999000111222',
    status: 'ACTIVE',
    expireAt: '2026-08-21T00:00:00.000Z',
    telegramId: 999000111222,
    subscriptionUrl: 'https://sub.test/api/sub/TESTshortUuid001',
    ...over,
  };
}

describe('findUserByTelegramId', () => {
  it('пустой массив → null (юзера в панели нет)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, { response: [] }));
    const client = makeClient(fetchMock);
    await expect(client.findUserByTelegramId('123')).resolves.toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://panel.test/api/users/by-telegram-id/123');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test_token');
  });

  it('юзер найден → парсится в доменный тип', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, { response: [panelUser()] }));
    const client = makeClient(fetchMock);
    const user = await client.findUserByTelegramId('999000111222');
    expect(user?.uuid).toBe('11111111-2222-4333-8444-555555555555');
    expect(user?.expireAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
  });

  it('HTTP-ошибка → RemnawaveApiError со статусом', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(401, { message: 'Unauthorized' }));
    const client = makeClient(fetchMock);
    await expect(client.findUserByTelegramId('123')).rejects.toMatchObject({
      name: 'RemnawaveApiError',
      status: 401,
    });
  });

  it('дрейф контракта (не тот shape) → RemnawaveContractError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(200, { users: [] }));
    const client = makeClient(fetchMock);
    await expect(client.findUserByTelegramId('123')).rejects.toBeInstanceOf(
      RemnawaveContractError,
    );
  });
});

describe('createUser', () => {
  it('шлёт username tg_<id>, числовой telegramId, squad и лимит трафика', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(201, { response: panelUser() }));
    const client = makeClient(fetchMock, 214748364800);
    const expireAt = new Date('2026-08-21T00:00:00.000Z');
    const user = await client.createUser({ telegramId: '999000111222', expireAt });
    expect(user.shortUuid).toBe('TESTshortUuid001');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://panel.test/api/users');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      username: 'tg_999000111222',
      telegramId: 999000111222,
      expireAt: '2026-08-21T00:00:00.000Z',
      trafficLimitBytes: 214748364800,
      trafficLimitStrategy: 'MONTH',
      activeInternalSquads: ['e819a231-6e10-46c6-8411-7001dd67e9e1'],
    });
  });

  it('нечисловой telegramId → RemnawaveContractError без похода в сеть', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock);
    await expect(
      client.createUser({ telegramId: 'abc', expireAt: new Date() }),
    ).rejects.toBeInstanceOf(RemnawaveContractError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('updateUser', () => {
  it('PATCH /users шлёт uuid и только переданные поля', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResp(200, { response: panelUser({ trafficLimitBytes: 214748364800 }) }),
    );
    const client = makeClient(fetchMock);
    await client.updateUser({
      uuid: '11111111-2222-4333-8444-555555555555',
      trafficLimitBytes: 214748364800,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://panel.test/api/users');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      uuid: '11111111-2222-4333-8444-555555555555',
      trafficLimitBytes: 214748364800,
    });
  });
});

describe('revokeSubscription', () => {
  it('POST /users/{uuid}/actions/revoke → юзер с НОВЫМ shortUuid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResp(200, {
        response: panelUser({
          shortUuid: 'TESTshortUuid002',
          subscriptionUrl: 'https://sub.test/api/sub/TESTshortUuid002',
          subRevokedAt: '2026-07-21T15:43:04.835Z',
        }),
      }),
    );
    const client = makeClient(fetchMock);
    const user = await client.revokeSubscription('11111111-2222-4333-8444-555555555555');
    expect(user.shortUuid).toBe('TESTshortUuid002');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://panel.test/api/users/11111111-2222-4333-8444-555555555555/actions/revoke',
    );
    expect(init.method).toBe('POST');
  });

  it('404 (юзера панели удалили вручную) → RemnawaveApiError.status === 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp(404, { message: 'User not found' }));
    const client = makeClient(fetchMock);
    await expect(client.revokeSubscription('00000000-0000-4000-8000-000000000000')).rejects.toSatisfy(
      (err: unknown) => err instanceof RemnawaveApiError && err.status === 404,
    );
  });
});

describe('deleteUser', () => {
  it('DELETE /users/{uuid} → isDeleted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResp(200, { response: { isDeleted: true } }));
    const client = makeClient(fetchMock);
    await expect(client.deleteUser('11111111-2222-4333-8444-555555555555')).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });
});

describe('remnawaveUsername', () => {
  it('детерминирован от telegramId', () => {
    expect(remnawaveUsername('42')).toBe('tg_42');
  });
});
