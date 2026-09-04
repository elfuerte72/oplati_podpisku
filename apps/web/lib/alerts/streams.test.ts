import { GrammyError } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Потоки уведомлений и ops-группа (трек ops-group, тикет 01).
 *
 * Что здесь держится — ЧТО ушло в Telegram и КУДА (chat id, thread id), а не
 * устройство модуля:
 *   - при заданной группе шлёт бот ВХОДА в тему потока;
 *   - незаданный thread id → корень группы, а не молчание;
 *   - протухшая тема → повтор в корень + одно сообщение в Sentry на процесс;
 *   - прочие сбои Sentry не трогают (анти-петля);
 *   - без группы — прежняя личка через alert-бота;
 *   - никогда не бросает, факт доставки возвращается честно.
 */

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  sendStaffMessage: vi.fn(async (..._args: unknown[]) => {}),
  sendAlert: vi.fn(async (..._args: unknown[]) => {}),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/env.server', () => ({ serverEnv: h.env }));
vi.mock('../env.server.ts', () => ({ serverEnv: h.env }));
vi.mock('../telegram/staff-bot-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telegram/staff-bot-client.ts')>();
  return { ...actual, sendStaffMessage: h.sendStaffMessage };
});
vi.mock('../telegram/alert-bot.ts', () => ({ sendAlert: h.sendAlert }));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: h.captureMessage,
  captureException: h.captureException,
}));

import { StaffBotNotConfiguredError } from '../telegram/staff-bot-client.ts';

import { notifyOps } from './notify-ops.ts';
import { isOpsDeliveryConfigured, notifyStream, opsGroup, resetStreamsForTests } from './streams.ts';

const GROUP = '-1001234567890';

function threadNotFound(): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed',
    { ok: false, error_code: 400, description: 'Bad Request: message thread not found' },
    'sendMessage',
    {},
  );
}

function configureGroup(threads: Partial<Record<string, string>> = {}) {
  h.env.OPS_GROUP_CHAT_ID = GROUP;
  h.env.OPS_GROUP_THREAD_CRITICAL = threads.critical ?? '11';
  h.env.OPS_GROUP_THREAD_PAYMENTS = threads.payments ?? '22';
  h.env.OPS_GROUP_THREAD_SUPPORT = threads.support ?? '33';
  h.env.OPS_GROUP_THREAD_ERRORS = threads.errors ?? '44';
  h.env.OPS_GROUP_THREAD_DEPLOY = threads.deploy ?? '55';
}

beforeEach(() => {
  for (const key of Object.keys(h.env)) delete h.env[key];
  h.sendStaffMessage.mockReset();
  h.sendStaffMessage.mockImplementation(async () => {});
  h.sendAlert.mockReset();
  h.sendAlert.mockImplementation(async () => {});
  h.captureMessage.mockClear();
  h.captureException.mockClear();
  resetStreamsForTests();
});

describe('opsGroup — конфигурация из env', () => {
  it('без OPS_GROUP_CHAT_ID группы нет', () => {
    expect(opsGroup()).toBeNull();
  });

  it('таблица «поток → thread id» читается из пяти переменных', () => {
    configureGroup();

    expect(opsGroup()).toEqual({
      chatId: GROUP,
      threads: { critical: 11, payments: 22, support: 33, errors: 44, deploy: 55 },
    });
  });

  it('незаданный thread id потока — корень группы (null), не ошибка', () => {
    h.env.OPS_GROUP_CHAT_ID = GROUP;
    h.env.OPS_GROUP_THREAD_CRITICAL = '11';

    expect(opsGroup()?.threads).toEqual({
      critical: 11,
      payments: null,
      support: null,
      errors: null,
      deploy: null,
    });
  });

  it('isOpsDeliveryConfigured: группа ИЛИ прежняя личка', () => {
    expect(isOpsDeliveryConfigured()).toBe(false);
    h.env.ALERT_TELEGRAM_CHAT_ID = '379336096';
    expect(isOpsDeliveryConfigured()).toBe(true);
    delete h.env.ALERT_TELEGRAM_CHAT_ID;
    h.env.OPS_GROUP_CHAT_ID = GROUP;
    expect(isOpsDeliveryConfigured()).toBe(true);
  });
});

describe('notifyStream при заданной группе', () => {
  beforeEach(() => configureGroup());

  it('шлёт ботом входа в группу с thread id потока', async () => {
    const ok = await notifyStream('payments', 'недоплата');

    expect(ok).toBe(true);
    expect(h.sendStaffMessage).toHaveBeenCalledWith(GROUP, 'недоплата', { messageThreadId: 22 });
    // Alert-бот и личка в группе не участвуют.
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  it('незаданный thread id потока → отправка в корень, без message_thread_id', async () => {
    delete h.env.OPS_GROUP_THREAD_DEPLOY;

    const ok = await notifyStream('deploy', 'бэкап сделан');

    expect(ok).toBe(true);
    expect(h.sendStaffMessage).toHaveBeenCalledWith(GROUP, 'бэкап сделан', {});
  });

  it('«message thread not found» → повтор в корень, доставлено, один Sentry на thread id', async () => {
    h.sendStaffMessage.mockImplementation(async (...args: unknown[]) => {
      const opts = args[2] as { messageThreadId?: number } | undefined;
      if (opts?.messageThreadId !== undefined) throw threadNotFound();
    });

    const first = await notifyStream('critical', 'сайт лежит');
    const second = await notifyStream('critical', 'ещё раз');

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Две попытки на сообщение: тема, затем корень.
    expect(h.sendStaffMessage).toHaveBeenCalledTimes(4);
    expect(h.sendStaffMessage).toHaveBeenNthCalledWith(2, GROUP, 'сайт лежит');
    expect(h.sendStaffMessage).toHaveBeenNthCalledWith(4, GROUP, 'ещё раз');
    // Дедуп на процесс: тема одна — сообщение в Sentry одно.
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
    expect(h.captureMessage.mock.calls[0]?.[1]).toMatchObject({ extra: { stream: 'critical', threadId: 11 } });
  });

  it('разные протухшие темы сообщаются каждая по разу', async () => {
    h.sendStaffMessage.mockImplementation(async (...args: unknown[]) => {
      const opts = args[2] as { messageThreadId?: number } | undefined;
      if (opts?.messageThreadId !== undefined) throw threadNotFound();
    });

    await notifyStream('critical', 'a');
    await notifyStream('payments', 'b');

    expect(h.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('reportToSentry: false — протухшая тема не зовёт Sentry (Sentry-релей, анти-петля)', async () => {
    h.sendStaffMessage.mockImplementation(async (...args: unknown[]) => {
      const opts = args[2] as { messageThreadId?: number } | undefined;
      if (opts?.messageThreadId !== undefined) throw threadNotFound();
    });

    const ok = await notifyStream('errors', 'issue', { reportToSentry: false });

    expect(ok).toBe(true);
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('повтор в корень тоже упал → не доставлено, без Sentry', async () => {
    h.sendStaffMessage
      .mockImplementationOnce(async () => {
        throw threadNotFound();
      })
      .mockImplementationOnce(async () => {
        throw new Error('tg down');
      });

    const ok = await notifyStream('critical', 'x');

    expect(ok).toBe(false);
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('другая ошибка Telegram → не доставлено, Sentry не зовётся (анти-петля), не бросает', async () => {
    h.sendStaffMessage.mockImplementation(async () => {
      throw new GrammyError(
        'Call to sendMessage failed',
        { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' },
        'sendMessage',
        {},
      );
    });

    await expect(notifyStream('critical', 'x')).resolves.toBe(false);
    expect(h.sendStaffMessage).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('незаданный токен бота входа при заданной группе — не доставлено, без фолбэка на другого бота', async () => {
    h.sendStaffMessage.mockImplementation(async () => {
      throw new StaffBotNotConfiguredError();
    });

    const ok = await notifyStream('critical', 'x');

    expect(ok).toBe(false);
    expect(h.sendAlert).not.toHaveBeenCalled();
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

});

describe('notifyStream без группы — прежняя схема', () => {
  it('шлёт в личку ALERT_TELEGRAM_CHAT_ID через alert-бота', async () => {
    h.env.ALERT_TELEGRAM_CHAT_ID = '379336096';

    const ok = await notifyStream('payments', 'недоплата');

    expect(ok).toBe(true);
    expect(h.sendAlert).toHaveBeenCalledWith('379336096', 'недоплата');
    expect(h.sendStaffMessage).not.toHaveBeenCalled();
  });

  it('ни группы, ни лички → не доставлено, не бросает', async () => {
    await expect(notifyStream('payments', 'x')).resolves.toBe(false);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  it('сбой alert-бота → не доставлено, Sentry не зовётся', async () => {
    h.env.ALERT_TELEGRAM_CHAT_ID = '379336096';
    h.sendAlert.mockImplementation(async () => {
      throw new Error('tg down');
    });

    await expect(notifyStream('payments', 'x')).resolves.toBe(false);
    expect(h.captureException).not.toHaveBeenCalled();
  });
});

describe('notifyOps — обёртка с потоком', () => {
  it('при группе уходит в тему потока ботом входа', async () => {
    configureGroup();

    const ok = await notifyOps('оплаченный заказ не доставлен', { stream: 'critical' });

    expect(ok).toBe(true);
    expect(h.sendStaffMessage).toHaveBeenCalledWith(GROUP, 'оплаченный заказ не доставлен', {
      messageThreadId: 11,
    });
  });

  it('без группы — личка, как до трека', async () => {
    h.env.ALERT_TELEGRAM_CHAT_ID = '379336096';

    await notifyOps('текст', { stream: 'payments' });

    expect(h.sendAlert).toHaveBeenCalledWith('379336096', 'текст');
  });
});
