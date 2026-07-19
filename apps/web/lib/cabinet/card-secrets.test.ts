import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

const pay = vi.hoisted(() => ({ configured: true, getCardSecrets: vi.fn() }));
vi.mock('../pay-space/index.ts', () => ({
  isPaySpaceConfigured: () => pay.configured,
  getPaySpaceClient: () => ({ getCardSecrets: pay.getCardSecrets }),
}));

const dbState = vi.hoisted(() => ({ card: null as { providerCardId: string } | null }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  findCardByIdForUser: vi.fn(async () => dbState.card),
}));

import * as db from '@oplati/db';
import { getCardSecretsForUser } from './card-secrets.ts';

beforeEach(() => {
  vi.clearAllMocks();
  pay.configured = true;
  dbState.card = { providerCardId: 'p1' };
  pay.getCardSecrets.mockResolvedValue({ cardNo: '5592680100101726', cvv: '167', expDate: '06/27' });
});

describe('getCardSecretsForUser', () => {
  it('карта чужая/не найдена → not_found, PaySpace не дёргаем', async () => {
    dbState.card = null;
    expect(await getCardSecretsForUser('u1', 'c1')).toEqual({ ok: false, error: 'not_found' });
    expect(pay.getCardSecrets).not.toHaveBeenCalled();
  });

  it('PaySpace не настроен → unavailable', async () => {
    pay.configured = false;
    expect(await getCardSecretsForUser('u1', 'c1')).toEqual({ ok: false, error: 'unavailable' });
    expect(pay.getCardSecrets).not.toHaveBeenCalled();
  });

  it('успех → номер группами по 4 + срок + cvc; запрос по providerCardId владельца', async () => {
    const r = await getCardSecretsForUser('u1', 'c1');
    expect(r).toEqual({ ok: true, number: '5592 6801 0010 1726', exp: '06/27', cvc: '167' });
    expect(pay.getCardSecrets).toHaveBeenCalledWith('p1');
  });

  it('сбой PaySpace → unavailable; пойманная ошибка НЕ передаётся (captureMessage без err)', async () => {
    pay.getCardSecrets.mockRejectedValue(new Error('contract drift with raw body'));
    const r = await getCardSecretsForUser('u1', 'c1');
    expect(r).toEqual({ ok: false, error: 'unavailable' });
    // В Sentry уходит только сообщение + cardId, без объекта ошибки (защита от утечки).
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sentry.captureMessage.mock.calls[0]!;
    expect(JSON.stringify(opts)).not.toContain('contract drift');
  });

  it('findCardByIdForUser зовётся с (cardId, userId) — ownership', async () => {
    await getCardSecretsForUser('user-42', 'card-7');
    expect(db.findCardByIdForUser).toHaveBeenCalledWith(expect.anything(), 'card-7', 'user-42');
  });
});
