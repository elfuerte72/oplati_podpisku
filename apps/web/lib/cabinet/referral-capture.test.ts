import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Исход захвата реферера (`captureReferralForUser`) — то, чем бот решает, что
 * сказать после `/start ref_`. Главное: заход по СВОЕЙ ссылке — отдельный исход
 * с логом, а не молчаливый выход (разбор жалоб 2026-09-05: партнёр «проверял»
 * ссылку трижды и каждый раз видел обычное приветствие).
 */

const h = vi.hoisted(() => ({
  env: { REFERRAL_ENABLED: true },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  hasPurchasedOrders: vi.fn(),
  setReferrerOnce: vi.fn(),
  resolveReferralCode: vi.fn(),
}));

vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../logger.ts', () => ({ childLogger: () => h.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  hasPurchasedOrders: h.hasPurchasedOrders,
  setReferrerOnce: h.setReferrerOnce,
  resolveReferralCode: h.resolveReferralCode,
}));

import { captureReferralForUser, captureReferralFromStartParam } from './referral-capture.ts';

const USER = 'user-1';
const PARTNER = 'partner-1';

describe('captureReferralForUser — исход захвата', () => {
  beforeEach(() => {
    h.env.REFERRAL_ENABLED = true;
    h.log.info.mockClear();
    h.log.warn.mockClear();
    h.hasPurchasedOrders.mockReset().mockResolvedValue(false);
    h.setReferrerOnce.mockReset().mockResolvedValue({ set: true });
  });

  it('программа выключена → disabled, в БД не ходим', async () => {
    h.env.REFERRAL_ENABLED = false;
    await expect(
      captureReferralForUser({ userId: USER, referrerId: PARTNER, source: 'bot_start' }),
    ).resolves.toBe('disabled');
    expect(h.hasPurchasedOrders).not.toHaveBeenCalled();
  });

  it('своя ссылка → self_link с логом, без запросов в БД', async () => {
    await expect(
      captureReferralForUser({ userId: USER, referrerId: USER, source: 'bot_start' }),
    ).resolves.toBe('self_link');
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'referral.capture.self_link', userId: USER }),
    );
    expect(h.hasPurchasedOrders).not.toHaveBeenCalled();
    expect(h.setReferrerOnce).not.toHaveBeenCalled();
  });

  it('у пользователя уже есть покупки → has_purchases, реферер не ставится', async () => {
    h.hasPurchasedOrders.mockResolvedValue(true);
    await expect(
      captureReferralForUser({ userId: USER, referrerId: PARTNER, source: 'miniapp_startapp' }),
    ).resolves.toBe('has_purchases');
    expect(h.setReferrerOnce).not.toHaveBeenCalled();
  });

  it('реферер проставлен → set', async () => {
    await expect(
      captureReferralForUser({ userId: USER, referrerId: PARTNER, source: 'bot_start' }),
    ).resolves.toBe('set');
    expect(h.setReferrerOnce).toHaveBeenCalledWith({}, USER, PARTNER, h.log);
  });

  it.each(['already_set', 'cycle', 'user_not_found'] as const)(
    'setReferrerOnce не поставил (%s) → тот же исход наружу',
    async (reason) => {
      h.setReferrerOnce.mockResolvedValue({ set: false, reason });
      await expect(
        captureReferralForUser({ userId: USER, referrerId: PARTNER, source: 'bot_start' }),
      ).resolves.toBe(reason);
    },
  );

  it('сбой БД → failed, ошибка не пробрасывается', async () => {
    h.hasPurchasedOrders.mockRejectedValue(new Error('db down'));
    await expect(
      captureReferralForUser({ userId: USER, referrerId: PARTNER, source: 'bot_start' }),
    ).resolves.toBe('failed');
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'referral.capture.failed' }),
    );
  });
});

describe('captureReferralFromStartParam — start_param мини-аппа', () => {
  beforeEach(() => {
    h.env.REFERRAL_ENABLED = true;
    h.hasPurchasedOrders.mockReset().mockResolvedValue(false);
    h.setReferrerOnce.mockReset().mockResolvedValue({ set: true });
    h.resolveReferralCode.mockReset();
  });

  it('ref_<code> резолвится и делегируется в захват', async () => {
    h.resolveReferralCode.mockResolvedValue(PARTNER);
    await captureReferralFromStartParam({ userId: USER, startParam: 'ref_abc12345' });
    expect(h.resolveReferralCode).toHaveBeenCalledWith({}, 'abc12345');
    expect(h.setReferrerOnce).toHaveBeenCalledWith({}, USER, PARTNER, h.log);
  });

  it('чужой или пустой start_param — без запросов', async () => {
    await captureReferralFromStartParam({ userId: USER, startParam: null });
    await captureReferralFromStartParam({ userId: USER, startParam: 'order_42' });
    expect(h.resolveReferralCode).not.toHaveBeenCalled();
  });
});
