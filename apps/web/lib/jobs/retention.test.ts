import { beforeEach, describe, expect, it, vi } from 'vitest';

// Обязательные ключи для lazy-валидации serverEnv (logger).
process.env.APP_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const h = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  stripMock: vi.fn(),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  deleteOldMessages: h.deleteMock,
  stripOldPaymentPayloads: h.stripMock,
}));

import { runRetention } from './retention.ts';

beforeEach(() => {
  vi.clearAllMocks();
  h.deleteMock.mockResolvedValue(0);
  h.stripMock.mockResolvedValue(0);
});

describe('runRetention (M-13: чистка messages и raw_payload)', () => {
  it('пустая база → по одному пробному батчу, суммы нулевые', async () => {
    const result = await runRetention();

    expect(result).toEqual({ messagesDeleted: 0, payloadsStripped: 0 });
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
