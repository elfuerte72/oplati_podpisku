import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Клавиатура /start-меню (тикет 02 трека retention-funnel): кнопка «Отзывы»
 * живёт за env `REVIEWS_CHAT_URL` — задан → седьмая кнопка после
 * «Telegram-канал», не задан → прежнее меню из шести кнопок.
 *
 * Плюс обратная связь на `/start ref_<code>` (разбор жалоб 2026-09-05): другу —
 * что приглашение сработало, партнёру — DM, на свою ссылку — подсказка. До
 * этого любой заход по ссылке получал одно и то же приветствие.
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
  getUserTelegramId: vi.fn(),
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

import { captureReferralForUser } from '@/lib/cabinet/referral-capture';
import { getUserTelegramId, resolveReferralCode } from '@oplati/db';
import type { TelegramMessage, TelegramUpdate } from '@oplati/types';

import { persistInbound, safeAppendMessage } from './persist.ts';
import { sendSafely } from './send.ts';
import { buildStartMenuKeyboard, handleStartCommand } from './start-menu.ts';
import {
  REFERRAL_PARTNER_JOINED_TEXT,
  REFERRAL_SELF_LINK_TEXT,
  REFERRAL_WELCOME_TEXT,
  START_CHANNEL_BUTTON,
  START_REVIEWS_BUTTON,
} from './templates.ts';

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

describe('handleStartCommand — обратная связь на /start ref_', () => {
  const CHAT = 100;
  const PARTNER_ID = 'partner-uuid';
  const PARTNER_CHAT = 777;

  function startWith(text: string) {
    const message = {
      message_id: 5,
      date: 0,
      chat: { id: CHAT, type: 'private' },
      from: { id: CHAT, is_bot: false, first_name: 'Друг' },
      text,
    } as unknown as TelegramMessage;
    const update = { update_id: 1, message } as unknown as TelegramUpdate;
    return handleStartCommand(update, message, CHAT, text);
  }

  /** Тексты, ушедшие в чат друга и партнёру, в порядке отправки. */
  function sent(): Array<[number, string]> {
    return vi.mocked(sendSafely).mock.calls.map((c) => [c[0], c[1]]);
  }

  beforeEach(() => {
    h.env.REFERRAL_ENABLED = true;
    vi.mocked(safeAppendMessage).mockReset().mockResolvedValue(true);
    vi.mocked(sendSafely).mockReset().mockResolvedValue(true);
    vi.mocked(resolveReferralCode).mockReset().mockResolvedValue(PARTNER_ID);
    vi.mocked(getUserTelegramId).mockReset().mockResolvedValue(String(PARTNER_CHAT));
    vi.mocked(captureReferralForUser).mockReset().mockResolvedValue('already_set');
    vi.mocked(persistInbound)
      .mockReset()
      .mockResolvedValue({ userId: 'friend-uuid', conversationId: 'conv', userCreated: true });
  });

  it('новый друг: реферер ставится INSERT-ом, поздний захват не зовётся; другу — «по приглашению», партнёру — DM', async () => {
    await startWith('/start ref_abc12345');

    expect(vi.mocked(persistInbound).mock.calls[0]?.[2]).toEqual({ referredBy: PARTNER_ID });
    expect(captureReferralForUser).not.toHaveBeenCalled();
    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_WELCOME_TEXT],
      [PARTNER_CHAT, REFERRAL_PARTNER_JOINED_TEXT],
    ]);
    // Сказанное клиенту записано в переписку — лента панели его увидит.
    expect(safeAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'friend-uuid' }),
      'assistant',
      REFERRAL_WELCOME_TEXT,
      { source: 'referral_feedback' },
      1,
    );
  });

  it('persist упал (ctx === null) → только приветствие, захват и DM не зовутся, без исключения', async () => {
    vi.mocked(persistInbound).mockResolvedValue(null);

    await expect(startWith('/start ref_abc12345')).resolves.toBeUndefined();

    expect(captureReferralForUser).not.toHaveBeenCalled();
    expect(getUserTelegramId).not.toHaveBeenCalled();
    expect(sent()).toEqual([[CHAT, 'greeting']]);
  });

  it('другу не доставлено (403) → в переписку не пишем, партнёра всё равно уведомляем', async () => {
    vi.mocked(sendSafely).mockImplementation(async (_chat, text) => text !== REFERRAL_WELCOME_TEXT);

    await startWith('/start ref_abc12345');

    expect(safeAppendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      'assistant',
      REFERRAL_WELCOME_TEXT,
      expect.anything(),
      expect.anything(),
    );
    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_WELCOME_TEXT],
      [PARTNER_CHAT, REFERRAL_PARTNER_JOINED_TEXT],
    ]);
  });

  it('существующий пользователь, поздний захват состоялся → те же два сообщения', async () => {
    vi.mocked(persistInbound).mockResolvedValue({
      userId: 'friend-uuid',
      conversationId: 'conv',
      userCreated: false,
    });
    vi.mocked(captureReferralForUser).mockResolvedValue('set');

    await startWith('/start ref_abc12345');

    expect(captureReferralForUser).toHaveBeenCalledWith({
      userId: 'friend-uuid',
      referrerId: PARTNER_ID,
      source: 'bot_start',
    });
    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_WELCOME_TEXT],
      [PARTNER_CHAT, REFERRAL_PARTNER_JOINED_TEXT],
    ]);
  });

  it.each(['already_set', 'has_purchases', 'cycle', 'failed'] as const)(
    'ничего не изменилось (%s) → только приветствие, партнёра не беспокоим',
    async (outcome) => {
      vi.mocked(persistInbound).mockResolvedValue({
        userId: 'friend-uuid',
        conversationId: 'conv',
        userCreated: false,
      });
      vi.mocked(captureReferralForUser).mockResolvedValue(outcome);

      await startWith('/start ref_abc12345');

      expect(sent()).toEqual([[CHAT, 'greeting']]);
      expect(getUserTelegramId).not.toHaveBeenCalled();
    },
  );

  it('своя ссылка → подсказка вместо тишины, захват и DM не зовутся', async () => {
    vi.mocked(persistInbound).mockResolvedValue({
      userId: PARTNER_ID,
      conversationId: 'conv',
      userCreated: false,
    });

    await startWith('/start ref_abc12345');

    expect(captureReferralForUser).not.toHaveBeenCalled();
    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_SELF_LINK_TEXT],
    ]);
    expect(getUserTelegramId).not.toHaveBeenCalled();
  });

  it('партнёр — веб-строка без Telegram → другу сообщение уходит, DM нет', async () => {
    vi.mocked(getUserTelegramId).mockResolvedValue(null);

    await startWith('/start ref_abc12345');

    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_WELCOME_TEXT],
    ]);
  });

  it('сбой поиска партнёра не роняет обработчик: друг уже получил своё', async () => {
    vi.mocked(getUserTelegramId).mockRejectedValue(new Error('db down'));

    await expect(startWith('/start ref_abc12345')).resolves.toBeUndefined();

    expect(sent()).toEqual([
      [CHAT, 'greeting'],
      [CHAT, REFERRAL_WELCOME_TEXT],
    ]);
  });

  it('неизвестный код → обычный /start без реферальных сообщений', async () => {
    vi.mocked(resolveReferralCode).mockResolvedValue(null);

    await startWith('/start ref_nobody00');

    expect(vi.mocked(persistInbound).mock.calls[0]?.[2]).toEqual({ referredBy: null });
    expect(sent()).toEqual([[CHAT, 'greeting']]);
  });

  it('программа выключена → код даже не резолвится', async () => {
    h.env.REFERRAL_ENABLED = false;

    await startWith('/start ref_abc12345');

    expect(resolveReferralCode).not.toHaveBeenCalled();
    expect(sent()).toEqual([[CHAT, 'greeting']]);
  });
});
