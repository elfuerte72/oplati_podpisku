import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_URL = 'https://example.com';

/**
 * «Клиент написал в бота» — уведомление персоналу на любое входящее сообщение.
 *
 * Что здесь держится:
 *   - контакт в шапке пригоден для ДЕЙСТВИЯ: рабочая ссылка на личку либо
 *     прямая правда, что её нет;
 *   - дубль и в группу, и личкой (решение владельца 2026-09-09);
 *   - дедуп на клиента — серия сообщений не даёт серию пингов;
 *   - сбой доставки не роняет обработку апдейта.
 */

const notifyStaff = vi.hoisted(() =>
  vi.fn(async () => ({ delivered: 1, failed: 0, deduped: false })),
);

vi.mock('@/lib/alerts/notify-staff', () => ({ notifyStaff }));

import { INBOUND_ALERT_DEDUP_MS, notifyStaffAboutInboundMessage } from './inbound-alert.ts';

beforeEach(() => {
  notifyStaff.mockClear();
});

function lastCall() {
  const call = notifyStaff.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
  return { text: call[0], opts: call[1] };
}

describe('уведомление о входящем сообщении клиента', () => {
  it('шапка несёт рабочую ссылку на личку и текст клиента', async () => {
    await notifyStaffAboutInboundMessage({
      telegramId: 123,
      firstName: 'Нигора',
      username: 'nigora_n',
      text: 'Не подключился',
      updateId: 1,
    });

    const { text, opts } = lastCall();
    expect(text).toContain('Клиент написал в бота');
    expect(text).toContain('https://t.me/nigora_n');
    expect(text).toContain('Не подключился');
    // Разметка снята: бот входа шлёт простым текстом, теги остались бы у
    // человека в виде «&lt;b&gt;».
    expect(text).not.toContain('<b>');
    expect(opts).toMatchObject({ capability: 'support', alsoDirect: true });
  });

  /*
   * Клиент без @username — у нас каждый восьмой. Персоналу важно не «прочерк»,
   * а то, что писать придётся через панель: это меняет его следующее действие.
   */
  it('без username говорит прямо, что личка недоступна', async () => {
    await notifyStaffAboutInboundMessage({
      telegramId: 8069374561,
      firstName: 'Nigora',
      text: 'Машенники',
      updateId: 2,
    });

    expect(lastCall().text).toContain('нет @username');
  });

  it('дедуп — по клиенту и на полчаса', async () => {
    await notifyStaffAboutInboundMessage({ telegramId: 42, text: 'раз', updateId: 3 });

    expect(lastCall().opts).toMatchObject({
      dedupKey: 'inbound-42',
      dedupWindowMs: INBOUND_ALERT_DEDUP_MS,
    });
    expect(INBOUND_ALERT_DEDUP_MS).toBe(30 * 60 * 1000);
  });

  it('разные клиенты друг друга не глушат', async () => {
    await notifyStaffAboutInboundMessage({ telegramId: 1, text: 'a', updateId: 4 });
    const first = lastCall().opts.dedupKey;
    await notifyStaffAboutInboundMessage({ telegramId: 2, text: 'b', updateId: 5 });

    expect(first).not.toBe(lastCall().opts.dedupKey);
  });

  /*
   * Наблюдатель не роняет наблюдаемое: клиенту ответ уже ушёл, а брошенное
   * исключение здесь заставило бы Telegram переДОСТАВИТЬ апдейт — человек
   * получил бы дубль подсказки.
   */
  it('сбой доставки не бросает наружу', async () => {
    notifyStaff.mockRejectedValueOnce(new Error('telegram down'));

    await expect(
      notifyStaffAboutInboundMessage({ telegramId: 7, text: 'привет', updateId: 6 }),
    ).resolves.toBeUndefined();
  });

  it('медиа уходит пометкой, а не файлом', async () => {
    await notifyStaffAboutInboundMessage({ telegramId: 9, text: '[photo]', updateId: 7 });

    expect(lastCall().text).toContain('[photo]');
  });
});
