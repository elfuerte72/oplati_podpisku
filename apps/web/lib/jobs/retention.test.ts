import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  stripMock: vi.fn(),
  analyticsDeleteMock: vi.fn(),
  dictionaryMock: vi.fn(),
  fundReservationsDeleteMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  deleteOldMessages: h.deleteMock,
  stripOldPaymentPayloads: h.stripMock,
  deleteOldAnalyticsEvents: h.analyticsDeleteMock,
  syncAnalyticsDictionary: h.dictionaryMock,
  deleteExpiredCardFundReservations: h.fundReservationsDeleteMock,
}));

import { runRetention } from './retention.ts';

beforeEach(() => {
  vi.clearAllMocks();
  h.deleteMock.mockResolvedValue(0);
  h.stripMock.mockResolvedValue(0);
  h.analyticsDeleteMock.mockResolvedValue(0);
  h.dictionaryMock.mockResolvedValue(25);
  h.fundReservationsDeleteMock.mockResolvedValue(0);
});

describe('runRetention (M-13: чистка messages и raw_payload)', () => {
  it('пустая база → по одному пробному батчу, суммы нулевые', async () => {
    const result = await runRetention();

    expect(result).toEqual({
      messagesDeleted: 0,
      payloadsStripped: 0,
      analyticsDeleted: 0,
      dictionarySynced: 25,
      fundReservationsDeleted: 0,
    });
    expect(h.deleteMock).toHaveBeenCalledTimes(1);
    expect(h.stripMock).toHaveBeenCalledTimes(1);
    // Сроки — решение владельца 2026-07-19: 90 дней переписка, 180 — raw_payload.
    expect(h.deleteMock).toHaveBeenCalledWith(
      expect.anything(),
      { olderThanDays: 90, limit: 500 },
      expect.anything(),
    );
    expect(h.stripMock).toHaveBeenCalledWith(
      expect.anything(),
      { olderThanDays: 180, limit: 500 },
      expect.anything(),
    );
  });

  it('полный батч → продолжает до неполного, суммируя удалённые', async () => {
    h.deleteMock
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(120);

    const result = await runRetention();

    expect(result.messagesDeleted).toBe(1120);
    expect(h.deleteMock).toHaveBeenCalledTimes(3);
  });

  it('бэклог больше потолка прогона → останавливается на MAX_BATCHES (дочистит завтра)', async () => {
    h.deleteMock.mockResolvedValue(500);

    const result = await runRetention();

    expect(h.deleteMock).toHaveBeenCalledTimes(20);
    expect(result.messagesDeleted).toBe(10_000);
  });
});

describe('runRetention — чистка занятий фонда (тикет 05)', () => {
  it('протухшие занятия убираются: таблицу читают под глобальным замком', async () => {
    h.fundReservationsDeleteMock.mockResolvedValueOnce(7);

    const result = await runRetention();

    expect(result.fundReservationsDeleted).toBe(7);
  });

  it('таблицы ещё нет — джоб доводит остальную чистку до конца', async () => {
    // Миграция применяется руками, и до неё запроса не существует. Падение
    // здесь унесло бы уже выполненную чистку переписки и payload'ов.
    h.fundReservationsDeleteMock.mockRejectedValueOnce(
      new Error('relation "vcc_fund_reservations" does not exist'),
    );
    h.deleteMock.mockResolvedValueOnce(3);

    const result = await runRetention();

    expect(result.messagesDeleted).toBe(3);
    expect(result.fundReservationsDeleted).toBe(0);
  });
});
