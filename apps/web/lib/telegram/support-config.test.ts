import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Доставка обращений персоналу (`sendToSupportOperator`).
 *
 * Что здесь держится (трек ops-group, тикет 03):
 *   - канал ОДИН — `notifyStaff` с капабилити `support` (бот входа);
 *   - клиентский бот операторам не пишет ни в одной ветке — резервный путь
 *     через `SUPPORT_OPERATOR_CHAT_ID` удалён вместе с переменной;
 *   - «не доставлено» возвращается честно: это единственный канал связи с
 *     клиентом, и «передали» при недоставленном обращении было бы ложью.
 */

const h = vi.hoisted(() => ({
  clientBotSend: vi.fn(async () => ({})),
  // ⚠️ Доставку персоналу мокаем ЯВНО: без мока вызов уходил бы в базу и падал
  // на незаданном DATABASE_URL, а тест был бы зелёным по случайности.
  notifyStaffMock: vi.fn(async (..._args: unknown[]) => ({
    delivered: 0,
    failed: 0,
    deduped: false,
  })),
}));

vi.mock('./bot', () => ({ getBot: () => ({ api: { sendMessage: h.clientBotSend } }) }));
vi.mock('@/lib/alerts/notify-staff', () => ({ notifyStaff: h.notifyStaffMock }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import { sendToSupportOperator } from './support.ts';

describe('sendToSupportOperator — обращение уходит ПЕРСОНАЛУ ботом входа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.notifyStaffMock.mockResolvedValue({ delivered: 1, failed: 0, deduped: false });
  });

  it('доставлено персоналу → true, капабилити support', async () => {
    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(true);
    expect(h.notifyStaffMock).toHaveBeenCalledWith(
      expect.stringContaining('обращение'),
      expect.objectContaining({ capability: 'support' }),
    );
  });

  it('клиентский бот не вызывается ни при успехе, ни при провале', async () => {
    await sendToSupportOperator('<b>обращение</b>');
    h.notifyStaffMock.mockResolvedValue({ delivered: 0, failed: 1, deduped: false });
    await sendToSupportOperator('<b>обращение</b>');

    expect(h.clientBotSend).not.toHaveBeenCalled();
  });

  it('персоналу не ушло — false + Sentry, без второго эшелона', async () => {
    h.notifyStaffMock.mockResolvedValue({ delivered: 0, failed: 1, deduped: false });

    const ok = await sendToSupportOperator('<b>обращение</b>');

    expect(ok).toBe(false);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('не доставлено');
  });

  it('фолбэк владельцу через notifyOps выключен: «доставлено» там равно нулю', async () => {
    await sendToSupportOperator('текст');

    expect(h.notifyStaffMock.mock.calls[0]?.[1]).toMatchObject({ fallbackToOps: false });
  });

  it('в текст персоналу уходит СНЯТАЯ разметка, а не сырой HTML', async () => {
    await sendToSupportOperator('<b>Клиент</b>: не проходит оплата');

    const text = String(h.notifyStaffMock.mock.calls[0]?.[0]);
    expect(text).not.toContain('<b>');
    expect(text).toContain('Клиент: не проходит оплата');
  });

  it('notifyStaff бросил — false, вызывающий не падает', async () => {
    h.notifyStaffMock.mockRejectedValueOnce(new Error('unexpected'));

    await expect(sendToSupportOperator('текст')).resolves.toBe(false);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
