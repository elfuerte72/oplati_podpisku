import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';

const h = vi.hoisted(() => ({
  sendMock: vi.fn(async () => undefined),
  findStaffMock: vi.fn(async () => null as null | { id: string; isActive: boolean }),
  rateLimitMock: vi.fn(async () => ({ allowed: true })),
  usernameMock: vi.fn(async () => 'oplatishkaa_bot'),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === 'TELEGRAM_LOGIN_BOT_TOKEN' ? '7992756364:staff' : undefined,
    },
  ),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  findStaffByTelegramId: h.findStaffMock,
}));

vi.mock('./staff-bot-client', () => ({ sendStaffMessage: h.sendMock }));

vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: h.rateLimitMock }));

vi.mock('./bot', () => ({ getBotUsername: h.usernameMock }));

import { handleStaffBotUpdate } from './staff-bot';
import {
  CLIENT_BOT_FALLBACK_USERNAME,
  STAFF_BOT_IDLE_TEXT,
  STAFF_BOT_START_TEXT,
  staffBotOutsiderText,
} from './templates';

function update(text: string, fromId = 379336096) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: fromId, type: 'private' as const },
      from: { id: fromId, is_bot: false, first_name: 'Кто-то' },
      text,
    },
  };
}

/**
 * Бот персонала (`@oplatishkaasupport_bot`): первый фактор входа и доставка
 * уведомлений. Боты публичны — клиент может найти его поиском и написать.
 * Постороннему он отвечает одной строкой и больше ничего не делает.
 */
describe('handleStaffBotUpdate', () => {
  beforeEach(() => {
    h.sendMock.mockClear();
    h.findStaffMock.mockClear();
    h.findStaffMock.mockImplementation(async () => null);
    h.rateLimitMock.mockClear();
    h.rateLimitMock.mockImplementation(async () => ({ allowed: true }));
    h.usernameMock.mockClear();
    h.usernameMock.mockImplementation(async () => 'oplatishkaa_bot');
  });

  it('сотруднику на /start подтверждает подключение уведомлений', async () => {
    h.findStaffMock.mockImplementation(async () => ({ id: 's1', isActive: true }));

    await handleStaffBotUpdate(update('/start'));

    expect(h.sendMock).toHaveBeenCalledWith(379336096, STAFF_BOT_START_TEXT);
  });

  it('постороннему отвечает одной строкой и уводит в клиентского бота', async () => {
    await handleStaffBotUpdate(update('привет, помогите оплатить'));

    expect(h.sendMock).toHaveBeenCalledWith(
      379336096,
      staffBotOutsiderText('oplatishkaa_bot'),
    );
    // Имя клиентского бота резолвится через getMe, а не пишется строкой: оно
    // уже менялось однажды, и копия оставила бы ссылку на мёртвый аккаунт.
    expect(h.usernameMock).toHaveBeenCalled();
  });

  it('getMe не ответил — уводим по известному имени, а не молчим', async () => {
    h.usernameMock.mockImplementation(async () => {
      throw new Error('telegram down');
    });

    await handleStaffBotUpdate(update('привет'));

    expect(h.sendMock).toHaveBeenCalledWith(
      379336096,
      staffBotOutsiderText(CLIENT_BOT_FALLBACK_USERNAME),
    );
  });

  it('поток сообщений от постороннего режется лимитом', async () => {
    h.rateLimitMock.mockImplementation(async () => ({ allowed: false }));

    await handleStaffBotUpdate(update('спам'));

    expect(h.sendMock).not.toHaveBeenCalled();
    expect(h.findStaffMock).not.toHaveBeenCalled();
  });

  it('отключённый сотрудник — тоже посторонний', async () => {
    h.findStaffMock.mockImplementation(async () => ({ id: 's1', isActive: false }));

    await handleStaffBotUpdate(update('/start'));

    expect(h.sendMock).toHaveBeenCalledWith(
      379336096,
      staffBotOutsiderText('oplatishkaa_bot'),
    );
  });

  it('сотрудник пишет не команду — короткий ответ, а не подтверждение подключения', async () => {
    h.findStaffMock.mockImplementation(async () => ({ id: 's1', isActive: true }));

    await handleStaffBotUpdate(update('а как посмотреть заказы?'));

    expect(h.sendMock).toHaveBeenCalledWith(379336096, STAFF_BOT_IDLE_TEXT);
  });

  it('апдейт без сообщения игнорируется молча', async () => {
    await handleStaffBotUpdate({ update_id: 2 });

    expect(h.sendMock).not.toHaveBeenCalled();
    expect(h.findStaffMock).not.toHaveBeenCalled();
  });

  it('сбой отправки не пробрасывается наружу — вебхук обязан ответить 200', async () => {
    h.sendMock.mockImplementation(async () => {
      throw new Error('403 bot was blocked by the user');
    });

    await expect(handleStaffBotUpdate(update('/start'))).resolves.toBeUndefined();
  });

  it('сбой базы не пробрасывается наружу', async () => {
    h.findStaffMock.mockImplementation(async () => {
      throw new Error('db down');
    });

    await expect(handleStaffBotUpdate(update('/start'))).resolves.toBeUndefined();
    // Молчание лучше, чем ответ постороннему от имени служебного бота при
    // неизвестном статусе отправителя.
    expect(h.sendMock).not.toHaveBeenCalled();
  });
});
