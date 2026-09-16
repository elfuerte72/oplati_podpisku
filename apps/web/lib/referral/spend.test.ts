import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {
    REFERRAL_ENABLED: true,
    REFERRAL_SPEND_ENABLED: true,
    REFERRAL_SPEND_ALLOWLIST: '',
    REFERRAL_SPEND_MIN_USD_CENTS: 100,
    REFERRAL_SPEND_RATE_BONUS_PERCENT: 0,
    // Минимум активного шлюза берётся из настоящего `gateway.ts` (L&P, 500 ₽).
    LOVEANDPAY_MIN_AMOUNT_RUB: 500,
  },
  state: {
    balance: 1000,
    telegramId: '42' as string | null,
    suspended: false,
  },
  reserveMock: vi.fn(
    async () =>
      ({ ok: true, balanceUsdCents: 646 }) as
        | { ok: true; balanceUsdCents: number }
        | {
            ok: false;
            reason: string;
            balanceUsdCents: number;
            existing?: { discountKopecks: number; amountUsdCents: number };
          },
  ),
  releaseMock: vi.fn(async () => ({ applied: true, redemption: null })),
  appendEventMock: vi.fn(async () => {}),
  selfReferralMock: vi.fn(
    async () => [] as { signal: string; partnerUserId: string; referralUserId: string }[],
  ),
  notifyStaffMock: vi.fn(
    async (_body: string, _opts: Record<string, unknown>) =>
      ({ delivered: 1, failed: 0, deduped: false }),
  ),
}));

vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../logger.ts', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('../alerts/notify-staff.ts', () => ({ notifyStaff: h.notifyStaffMock }));
vi.mock('../payments/gateway.ts', () => ({
  primaryPaymentGateway: () => 'loveandpay' as const,
  minAmountRubFor: () => 500,
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  getUserTelegramId: vi.fn(async () => h.state.telegramId),
  getPartnerProfile: vi.fn(async () => ({ suspended: h.state.suspended })),
  getReferralBalanceUsdCents: vi.fn(async () => h.state.balance),
  reserveBonusForOrder: h.reserveMock,
  releaseUnusedBonusReservation: h.releaseMock,
  findRedemptionByOrderId: vi.fn(async () => null),
  findSelfReferralSignals: h.selfReferralMock,
  appendOrderEvent: h.appendEventMock,
  BONUS_RELEASED_EVENT: 'bonus_released',
}));

import {
  claimBonusForOrder,
  loadBonusSpendState,
  loadBonusSpendStateSafe,
  resetSelfReferralDedupForTests,
} from './spend.ts';

/** Netflix из worked example спеки: 2008 ₽, комиссия 388,81 ₽, курс 81. */
const ORDER = {
  id: 'order-1',
  userId: 'user-1',
  amountRub: 200_800,
  originalAmount: 1599,
  cardIssueFeeKopecks: 32_400,
  usdtRubRateKopecks: 810_000,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.env.REFERRAL_ENABLED = true;
  h.env.REFERRAL_SPEND_ENABLED = true;
  h.env.REFERRAL_SPEND_ALLOWLIST = '';
  h.env.REFERRAL_SPEND_RATE_BONUS_PERCENT = 0;
  h.state.balance = 1000;
  h.state.telegramId = '42';
  h.state.suspended = false;
  h.reserveMock.mockResolvedValue({ ok: true, balanceUsdCents: 646 });
  h.selfReferralMock.mockResolvedValue([]);
  resetSelfReferralDedupForTests();
});

describe('loadBonusSpendState — гейты доступа', () => {
  it('включённая фича и живой баланс дают предложение', async () => {
    const state = await loadBonusSpendState(ORDER);

    expect(state).not.toBeNull();
    expect(state?.balanceUsdCents).toBe(1000);
    // Баланс $10 больше потолка: скидка упирается в комиссию 388,81 → 388 ₽.
    expect(state?.offer).toEqual({ discountKopecks: 38_800, spendUsdCents: 480 });
    expect(state?.capKopecks).toBe(38_800);
  });

  it('выключенный REFERRAL_SPEND_ENABLED убирает блок целиком', async () => {
    h.env.REFERRAL_SPEND_ENABLED = false;
    expect(await loadBonusSpendState(ORDER)).toBeNull();
  });

  it('выключенный глобальный REFERRAL_ENABLED тоже убирает блок', async () => {
    h.env.REFERRAL_ENABLED = false;
    expect(await loadBonusSpendState(ORDER)).toBeNull();
  });

  it('клиент вне allowlist блока не получает, а внутри — получает', async () => {
    h.env.REFERRAL_SPEND_ALLOWLIST = '777, 888';
    expect(await loadBonusSpendState(ORDER)).toBeNull();

    h.env.REFERRAL_SPEND_ALLOWLIST = '777, 42';
    expect(await loadBonusSpendState(ORDER)).not.toBeNull();
  });

  it('партнёр, заблокированный антифродом, баллы не тратит', async () => {
    h.state.suspended = true;
    expect(await loadBonusSpendState(ORDER)).toBeNull();
  });

  it('нулевой баланс — блока нет вовсе (клиенту без баллов ничего не показываем)', async () => {
    h.state.balance = 0;
    expect(await loadBonusSpendState(ORDER)).toBeNull();
  });

  it('баланс ниже минимума даёт состояние «копятся»: блок есть, предложения нет', async () => {
    h.state.balance = 40;
    const state = await loadBonusSpendState(ORDER);

    expect(state?.balanceUsdCents).toBe(40);
    expect(state?.offer).toBeNull();
    expect(state?.minSpendUsdCents).toBe(100);
  });

  it('ВИТРИНА переживает сбой чтения: блока нет, экран заказа цел', async () => {
    const db = await import('@oplati/db');
    vi.mocked(db.getReferralBalanceUsdCents).mockRejectedValueOnce(new Error('db down'));

    expect(await loadBonusSpendStateSafe(ORDER)).toBeNull();
  });

  it('на ПУТИ ОПЛАТЫ сбой не глотается — иначе счёт уйдёт на полную сумму', async () => {
    const db = await import('@oplati/db');
    vi.mocked(db.getReferralBalanceUsdCents).mockRejectedValueOnce(new Error('db down'));

    await expect(loadBonusSpendState(ORDER)).rejects.toThrow('db down');
  });
});

describe('claimBonusForOrder — три исхода', () => {
  it('фича клиента не касается → skipped, занятие не зовётся', async () => {
    h.env.REFERRAL_SPEND_ENABLED = false;

    expect(await claimBonusForOrder(ORDER)).toEqual({ kind: 'skipped' });
    expect(h.reserveMock).not.toHaveBeenCalled();
  });

  it('успех → claimed с тем же планом, что показан на экране', async () => {
    const result = await claimBonusForOrder(ORDER);

    expect(result).toEqual({
      kind: 'claimed',
      owned: true,
      plan: { discountKopecks: 38_800, spendUsdCents: 480 },
    });
    expect(h.reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'order-1',
        userId: 'user-1',
        spendUsdCents: 480,
        discountKopecks: 38_800,
        rateKopecks: 810_000,
      }),
    );
  });

  it('гонка с заявкой на вывод → unavailable с АКТУАЛЬНЫМ балансом', async () => {
    h.reserveMock.mockResolvedValue({
      ok: false,
      reason: 'insufficient_balance',
      balanceUsdCents: 12,
    });

    expect(await claimBonusForOrder(ORDER)).toEqual({ kind: 'unavailable', balanceUsdCents: 12 });
  });

  it('сбой чтения баланса → unavailable, а НЕ тихий полный счёт', async () => {
    // Проглоченная ошибка здесь означала бы счёт на полную сумму клиенту,
    // который нажал «оплатить со списанием баллов» (находка ревью).
    const db = await import('@oplati/db');
    vi.mocked(db.getReferralBalanceUsdCents).mockRejectedValueOnce(new Error('db down'));

    expect((await claimBonusForOrder(ORDER)).kind).toBe('unavailable');
    expect(h.reserveMock).not.toHaveBeenCalled();
  });

  it('чужое занятие того же заказа — claimed с ЕГО суммой и без владения', async () => {
    // Двойной тап или вторая вкладка. Ответить «баланс изменился» здесь значит
    // соврать: счёт со скидкой как раз выставляется другой попыткой. А снимать
    // это занятие в своём catch нельзя — оно принадлежит ей.
    h.reserveMock.mockResolvedValue({
      ok: false,
      reason: 'already_reserved',
      balanceUsdCents: 646,
      existing: { discountKopecks: 28_600, amountUsdCents: 354 },
    });

    expect(await claimBonusForOrder(ORDER)).toEqual({
      kind: 'claimed',
      owned: false,
      plan: { discountKopecks: 28_600, spendUsdCents: 354 },
    });
  });

  it('баланс упал ниже минимума → unavailable, а НЕ тихий полный счёт', async () => {
    // Клиент нажал «оплатить со скидкой»: молча выставить полный счёт — обман.
    h.state.balance = 40;

    expect(await claimBonusForOrder(ORDER)).toEqual({ kind: 'unavailable', balanceUsdCents: 40 });
    expect(h.reserveMock).not.toHaveBeenCalled();
  });
});

/**
 * E3-lite (решение Q6): списание впервые делает баланс настоящими деньгами и
 * вместе с этим — выгодным мультиаккаунтный самореферал. Сигнал, а не блок:
 * совпадение IP это ещё и семья, и наш собственный VPN.
 */
describe('сигнал самореферала', () => {
  it('совпадение контактов партнёра и его реферала → уведомление персоналу', async () => {
    h.selfReferralMock.mockResolvedValue([
      { signal: 'ip', partnerUserId: 'user-1', referralUserId: 'friend-1' },
    ]);

    await claimBonusForOrder(ORDER);

    expect(h.notifyStaffMock).toHaveBeenCalledTimes(1);
    expect(h.notifyStaffMock.mock.calls[0]?.[1]).toMatchObject({ capability: 'partners' });
  });

  it('разные контакты сигнала не дают', async () => {
    await claimBonusForOrder(ORDER);
    expect(h.notifyStaffMock).not.toHaveBeenCalled();
  });

  it('второе списание в те же сутки не шлёт второе уведомление', async () => {
    h.selfReferralMock.mockResolvedValue([
      { signal: 'email', partnerUserId: 'user-1', referralUserId: 'friend-1' },
    ]);

    await claimBonusForOrder(ORDER);
    await claimBonusForOrder(ORDER);

    expect(h.notifyStaffMock).toHaveBeenCalledTimes(1);
  });

  it('сбой эвристики не мешает занять баллы', async () => {
    h.selfReferralMock.mockRejectedValue(new Error('db down'));

    expect((await claimBonusForOrder(ORDER)).kind).toBe('claimed');
  });
});
