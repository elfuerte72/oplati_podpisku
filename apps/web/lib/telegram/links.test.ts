import { describe, expect, it } from 'vitest';

import {
  telegramBotLink,
  telegramMiniAppLink,
  telegramShareLink,
} from './links';

describe('Telegram web links', () => {
  it('создаёт ссылку на Telegram без start payload', () => {
    expect(telegramBotLink('ooplatishka')).toBe(
      'https://telegram.me/ooplatishka',
    );
  });

  it('сохраняет referral payload в bot deep-link на telegram.me', () => {
    expect(telegramBotLink('oplatishkaa_bot', 'ref_w9srx2t7')).toBe(
      'https://telegram.me/oplatishkaa_bot?start=ref_w9srx2t7',
    );
  });

  it('сохраняет link-token payload в bot deep-link на telegram.me', () => {
    expect(telegramBotLink('oplatishkaa_bot', 'link_abc-123_xyz')).toBe(
      'https://telegram.me/oplatishkaa_bot?start=link_abc-123_xyz',
    );
  });

  it('сохраняет startapp payload в прямой ссылке на Mini App', () => {
    expect(
      telegramMiniAppLink(
        'oplatishkaa_bot',
        'oplatishkaMiniApp',
        'ref_w9srx2t7',
      ),
    ).toBe(
      'https://telegram.me/oplatishkaa_bot/oplatishkaMiniApp?startapp=ref_w9srx2t7',
    );
  });

  it('кодирует ссылку и текст для Telegram share URL', () => {
    expect(
      telegramShareLink(
        'https://telegram.me/oplatishkaa_bot?start=ref_w9srx2t7',
        'Оплатишка — попробуй!',
      ),
    ).toBe(
      'https://telegram.me/share/url?url=https%3A%2F%2Ftelegram.me%2Foplatishkaa_bot%3Fstart%3Dref_w9srx2t7&text=%D0%9E%D0%BF%D0%BB%D0%B0%D1%82%D0%B8%D1%88%D0%BA%D0%B0%20%E2%80%94%20%D0%BF%D0%BE%D0%BF%D1%80%D0%BE%D0%B1%D1%83%D0%B9!',
    );
  });
});
