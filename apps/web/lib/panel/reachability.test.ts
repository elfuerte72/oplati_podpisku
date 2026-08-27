import { describe, expect, it } from 'vitest';

import { clientReachability, isReachableInTelegram } from './reachability';

/**
 * На проде 47 клиентов из 103 без `telegram_id`. Помощник один на три экрана
 * (карточка клиента, напоминание об оплате, ответ в поддержке): три копии
 * условия однажды разъедутся, и менеджер получит кнопку ответа там, где
 * отвечать некуда.
 */
describe('clientReachability', () => {
  it('клиент с Telegram достижим', () => {
    expect(clientReachability({ telegramId: '379336096' })).toEqual({
      reachable: true,
      reason: null,
    });
  });

  it('клиент только с сайта — недостижим, и причина сказана словами', () => {
    const res = clientReachability({ telegramId: null });

    expect(res.reachable).toBe(false);
    expect(res.reason).toBe('Нет Telegram');
  });

  it('пустая строка и пробелы — это тоже «писать некуда»', () => {
    // В базе telegram_id — text, и пустая строка туда попасть может. Считать её
    // адресом значило бы нарисовать кнопку ответа в пустоту.
    expect(isReachableInTelegram({ telegramId: '' })).toBe(false);
    expect(isReachableInTelegram({ telegramId: '   ' })).toBe(false);
  });
});
