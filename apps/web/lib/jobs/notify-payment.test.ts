import { describe, expect, it, vi } from 'vitest';

import { formatRub } from '@/components/comic/format';

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  getOrderById: vi.fn(),
  getServiceById: vi.fn(),
  getUserTelegramId: vi.fn(),
}));
vi.mock('../telegram/bot.ts', () => ({ getBot: () => ({ api: { sendMessage: vi.fn() } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { buildPaymentConfirmedMessage } from './notify-payment.ts';

/**
 * «Оплата получена» — первое, что клиент видит после оплаты. Разбор пути
 * клиента 2026-09-23: прежнее «пришлём всё в этот чат» звучало как обещание
 * готовой подписки, и клиенты ждали, что её подключат за них.
 */
describe('buildPaymentConfirmedMessage', () => {
  it('называет сервис и говорит, что подписку клиент оплатит сам картой', () => {
    const text = buildPaymentConfirmedMessage({ serviceName: 'ChatGPT', amountKopecks: 246_000 });

    expect(text).toContain(formatRub(246_000));
    expect(text).toContain('карту для ChatGPT');
    expect(text).toContain('ты сам оплатишь подписку на сайте сервиса');
    expect(text).not.toContain('пришлём всё');
    expect(text).not.toContain('ORD-');
  });

  it('без названия сервиса — нейтральная «виртуальная карта»', () => {
    const text = buildPaymentConfirmedMessage({ serviceName: null, amountKopecks: 100_000 });

    expect(text).toContain('виртуальную карту');
    expect(text).not.toContain('для null');
  });

  it('без суммы строка оплаты остаётся, но без «0 ₽»', () => {
    const text = buildPaymentConfirmedMessage({ serviceName: 'Claude', amountKopecks: null });

    expect(text.startsWith('Оплата получена. Спасибо!')).toBe(true);
    expect(text).not.toContain('₽');
  });
});
