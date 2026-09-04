import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Уведомления персоналу (тикет 11).
 *
 * Что здесь держится:
 *   - получатели берутся из `staff`, а не из одной переменной;
 *   - сотрудник, не запустивший бота входа, даёт 403 и НЕ глушит остальных;
 *   - дедуп: повторяющееся сообщение каждые 5 минут — способ, которым алёрты
 *     перестают читать (так был отключён алёрт баланса карт);
 *   - никогда не бросает: наблюдатель не роняет наблюдаемое.
 */

const h = vi.hoisted(() => ({
  listStaff: vi.fn(),
  sendStaffMessage: vi.fn(async (..._args: unknown[]) => {}),
  captureMessage: vi.fn(),
  notifyOps: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('@oplati/db', () => ({
  getDb: () => ({}) as unknown,
  listStaffRecipients: h.listStaff,
}));

vi.mock('@/lib/telegram/staff-bot-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telegram/staff-bot-client')>();
  return { ...actual, sendStaffMessage: h.sendStaffMessage };
});

vi.mock('@sentry/nextjs', () => ({ captureMessage: h.captureMessage, captureException: vi.fn() }));

// Второй эшелон (владелец) мокаем: его настоящая реализация читает env, а тут
// проверяется маршрутизация, а не доставка владельцу.
vi.mock('./notify-ops', () => ({ notifyOps: h.notifyOps }));

import { StaffBotNotConfiguredError } from '@/lib/telegram/staff-bot-client';

import { notifyStaff, resetStaffNotifyDedupForTests } from './notify-staff';

/**
 * База отсчёта времени. НЕ ноль: у общего `DedupWindow` пустая запись читается
 * как `0`, и на `now: 0` первое же сообщение считалось бы повтором — тест
 * падал бы по причине, к дедупу отношения не имеющей.
 */
const T0 = new Date('2026-08-18T12:00:00Z').getTime();

/**
 * Получатель — УЗКАЯ запись (id/telegramId/role), как её отдаёт
 * `listStaffRecipients`: секрет второго фактора в путь уведомлений не попадает
 * вовсе, и фикстура это фиксирует.
 */
function member(over: Record<string, unknown> = {}) {
  return { id: 'staff-1', telegramId: '111', role: 'operator', ...over };
}

beforeEach(() => {
  h.listStaff.mockReset();
  h.sendStaffMessage.mockReset();
  h.captureMessage.mockClear();
  h.notifyOps.mockClear();
  h.sendStaffMessage.mockImplementation(async () => {});
  h.listStaff.mockImplementation(async () => [member()]);
  resetStaffNotifyDedupForTests();
});

describe('notifyStaff', () => {
  it('шлёт всем активным сотрудникам с Telegram', async () => {
    h.listStaff.mockImplementation(async () => [
      member({ id: 's1', telegramId: '111' }),
      member({ id: 's2', telegramId: '222' }),
    ]);

    const res = await notifyStaff('заказ застрял', { capability: 'support' });

    expect(res.delivered).toBe(2);
    expect(h.sendStaffMessage).toHaveBeenCalledWith('111', 'заказ застрял');
    expect(h.sendStaffMessage).toHaveBeenCalledWith('222', 'заказ застрял');
  });

  it('роль без права на раздел уведомления НЕ получает', async () => {
    // Таблица прав заведена, чтобы новая роль не «падала в менеджера». Канал
    // в личку не должен её обходить, отдавая переписку клиента тому, кому
    // экран закрыт.
    h.listStaff.mockImplementation(async () => [
      member({ id: 's1', telegramId: '111', role: 'supervisor' }),
      member({ id: 's2', telegramId: '222', role: 'operator' }),
    ]);

    await notifyStaff('текст', { capability: 'support' });

    expect(h.sendStaffMessage).toHaveBeenCalledTimes(1);
    expect(h.sendStaffMessage).toHaveBeenCalledWith('222', 'текст');
  });

  it('партнёрские уведомления менеджеру не уходят — раздел владельца', async () => {
    h.listStaff.mockImplementation(async () => [
      member({ id: 's1', telegramId: '111', role: 'operator' }),
      member({ id: 's2', telegramId: '222', role: 'admin' }),
    ]);

    await notifyStaff('выплата', { capability: 'partners' });

    expect(h.sendStaffMessage).toHaveBeenCalledTimes(1);
    expect(h.sendStaffMessage).toHaveBeenCalledWith('222', 'выплата');
  });

  it('незаданный токен бота — это АВАРИЯ, а не тихая доставка', async () => {
    // Прежде `sendStaffMessage` при отсутствии токена молча возвращал void, и
    // обращение клиента считалось доставленным: клиент получал «передали в
    // поддержку», панель рисовала «доставлено», сообщение не уходило никуда.
    h.sendStaffMessage.mockImplementation(async () => {
      throw new StaffBotNotConfiguredError();
    });

    const res = await notifyStaff('текст', { capability: 'support' });

    expect(res.delivered).toBe(0);
    expect(res.failed).toBeGreaterThan(0);
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('403 у одного не отменяет доставку остальным', async () => {
    // Сотрудник, не запустивший бота входа, — самый частый случай. Без этого
    // из-за него молчали бы все.
    h.listStaff.mockImplementation(async () => [
      member({ id: 's1', telegramId: '111' }),
      member({ id: 's2', telegramId: '222' }),
    ]);
    h.sendStaffMessage.mockImplementation(async (chatId: unknown) => {
      if (chatId === '111') throw new Error('Forbidden: bot was blocked by the user');
    });

    const res = await notifyStaff('текст', { capability: 'support' });

    expect(res).toMatchObject({ delivered: 1, failed: 1 });
  });

  it('дедуп: второе сообщение с тем же ключом в окне не уходит', async () => {
    await notifyStaff('текст', { capability: 'support', dedupKey: 'stuck:order-1', now: T0 });
    const second = await notifyStaff('текст', { capability: 'support', dedupKey: 'stuck:order-1', now: T0 + 60_000 });

    expect(second.deduped).toBe(true);
    expect(h.sendStaffMessage).toHaveBeenCalledTimes(1);
  });

  it('разные ключи друг друга не глушат', async () => {
    await notifyStaff('a', { capability: 'support', dedupKey: 'stuck:order-1', now: T0 });
    await notifyStaff('b', { capability: 'support', dedupKey: 'hold:order-2', now: T0 });

    expect(h.sendStaffMessage).toHaveBeenCalledTimes(2);
  });

  it('через час окно открывается снова', async () => {
    await notifyStaff('текст', { capability: 'support', dedupKey: 'k', now: T0 });
    await notifyStaff('текст', { capability: 'support', dedupKey: 'k', now: T0 + 61 * 60_000 });

    expect(h.sendStaffMessage).toHaveBeenCalledTimes(2);
  });

  it('недоступная база не роняет вызывающего', async () => {
    // Уведомление — наблюдатель. Его сбой не должен ронять крон или вебхук.
    h.listStaff.mockImplementation(async () => {
      throw new Error('connection terminated');
    });

    await expect(notifyStaff('текст', { capability: 'support' })).resolves.toMatchObject({ delivered: 0 });
  });

  it('получателей нет — уходит ВЛАДЕЛЬЦУ, а не в тишину', async () => {
    // На проде `staff` пуст до ручного заведения и первого входа сотрудника, а
    // у баланса карт и застрявшего заказа второго телеграм-канала нет вовсе:
    // без фолбэка требование «алёрт обязан приходить лично» не выполнялось бы,
    // и узнать об этом можно было бы только из лога.
    h.listStaff.mockImplementation(async () => []);

    const res = await notifyStaff('текст', { capability: 'support' });

    expect(res).toMatchObject({ delivered: 0, failed: 0, deduped: false });
    // Поток фолбэка выводится из капабилити: обращения — «Поддержка».
    expect(h.notifyOps).toHaveBeenCalledWith('текст', { stream: 'support' });
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('фолбэк можно выключить явно', async () => {
    h.listStaff.mockImplementation(async () => []);

    await notifyStaff('текст', { capability: 'support', fallbackToOps: false });

    expect(h.notifyOps).not.toHaveBeenCalled();
  });

  it('доставлено персоналу — владельца не дублируем', async () => {
    await notifyStaff('текст', { capability: 'support' });

    expect(h.notifyOps).not.toHaveBeenCalled();
  });

  it('НЕсостоявшийся фолбэк владельцу окно дедупа не занимает', async () => {
    // `notifyOps` молчит по построению при незаданном `ALERT_TELEGRAM_CHAT_ID`
    // и при отказе Telegram (анти-петля). Записать окно по одной лишь попытке
    // значит получить час тишины при живой аварии — ровно в том случае, ради
    // которого фолбэк и заведён.
    h.listStaff.mockImplementation(async () => []);
    h.notifyOps.mockImplementation(async () => false);

    await notifyStaff('текст', { capability: 'holds', dedupKey: 'k', now: T0 });
    const second = await notifyStaff('текст', { capability: 'holds', dedupKey: 'k', now: T0 + 60_000 });

    expect(second.deduped).toBe(false);
    expect(h.notifyOps).toHaveBeenCalledTimes(2);
  });

  it('состоявшийся фолбэк владельцу окно занимает', async () => {
    h.listStaff.mockImplementation(async () => []);
    h.notifyOps.mockImplementation(async () => true);

    await notifyStaff('текст', { capability: 'holds', dedupKey: 'k2', now: T0 });
    const second = await notifyStaff('текст', { capability: 'holds', dedupKey: 'k2', now: T0 + 60_000 });

    expect(second.deduped).toBe(true);
    expect(h.notifyOps).toHaveBeenCalledTimes(1);
  });
});
