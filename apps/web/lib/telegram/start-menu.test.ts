import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Клавиатура /start-меню (тикет 02 трека retention-funnel): кнопка «Отзывы»
 * живёт за env `REVIEWS_CHAT_URL` — задан → седьмая кнопка после
 * «Telegram-канал», не задан → прежнее меню из шести кнопок.
 */

const h = vi.hoisted(() => ({
  env: { REVIEWS_CHAT_URL: undefined as string | undefined, REFERRAL_ENABLED: false },
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('@/lib/deployment-url', () => ({
  miniAppUrl: () => 'https://example.com/cabinet',
  siteUrl: () => 'https://example.com',
  paymentInstructionUrl: () => 'https://example.com/payment-instruction.html',
}));
vi.mock('@/lib/analytics/track', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/cabinet/referral-capture', () => ({ captureReferralForUser: vi.fn() }));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  LINK_TOKEN_PREFIX: 'link_',
  resolveReferralCode: vi.fn(),
}));
vi.mock('@oplati/agent', () => ({ GREETING: 'greeting' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('./persist', () => ({ persistInbound: vi.fn(), safeAppendMessage: vi.fn() }));
vi.mock('./send', () => ({ sendSafely: vi.fn() }));
vi.mock('./link-flow', () => ({ handleLinkDeepLink: vi.fn() }));
vi.mock('./support-flow', () => ({ handleSupportCommand: vi.fn() }));
vi.mock('./support-session', () => ({
  isSupportAiEnabled: () => false,
  openSupportFromBot: vi.fn(),
  resetSupportOnStart: vi.fn(),
}));

import { buildStartMenuKeyboard } from './start-menu.ts';
import { START_CHANNEL_BUTTON, START_REVIEWS_BUTTON } from './templates.ts';

type InlineButton = { text: string; url?: string };

function flatButtons(): InlineButton[] {
  return buildStartMenuKeyboard().inline_keyboard.flat() as InlineButton[];
}

describe('buildStartMenuKeyboard — кнопка «Отзывы» за REVIEWS_CHAT_URL', () => {
  beforeEach(() => {
    h.env.REVIEWS_CHAT_URL = undefined;
  });

  it('env не задан → прежнее меню из шести кнопок, «Отзывов» нет', () => {
    const buttons = flatButtons();
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => b.text)).not.toContain(START_REVIEWS_BUTTON);
  });

  it('env задан → url-кнопка «Отзывы» стоит после «Telegram-канал»', () => {
    h.env.REVIEWS_CHAT_URL = 'https://t.me/oplatishka1';

    const buttons = flatButtons();
    expect(buttons).toHaveLength(7);

    const channelIdx = buttons.findIndex((b) => b.text === START_CHANNEL_BUTTON);
    const reviewsIdx = buttons.findIndex((b) => b.text === START_REVIEWS_BUTTON);
    expect(reviewsIdx).toBe(channelIdx + 1);
    expect(buttons[reviewsIdx]?.url).toBe('https://t.me/oplatishka1');
  });
});
