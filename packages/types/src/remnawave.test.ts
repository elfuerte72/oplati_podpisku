import { describe, expect, it } from 'vitest';

import {
  remnawaveDeleteResponseSchema,
  remnawaveUserResponseSchema,
  remnawaveUsersByTelegramIdResponseSchema,
} from './remnawave.ts';

/**
 * Контракт Remnawave. Фикстуры — сокращённые ЖИВЫЕ ответы панели
 * (сняты 2026-07-21 с panel.mxpkn8ns.ru: create 201 / by-telegram-id 200 /
 * revoke 200 / delete 200).
 */

const LIVE_USER = {
  uuid: 'dd971f3c-9332-4821-9337-9ca95682758c',
  id: 8,
  shortUuid: '4wXbnJkbCGcZDKPP',
  username: 'tg_999000111222',
  status: 'ACTIVE',
  trafficLimitBytes: 0,
  trafficLimitStrategy: 'MONTH',
  expireAt: '2026-08-21T00:00:00.000Z',
  telegramId: 999000111222,
  email: null,
  vlessUuid: '94d841ad-1117-46f0-b58f-30901a6f3171',
  subRevokedAt: null,
  createdAt: '2026-07-21T15:42:45.202Z',
  subscriptionUrl: 'https://sub.mxpkn8ns.ru/api/sub/4wXbnJkbCGcZDKPP',
  activeInternalSquads: [
    { uuid: 'e819a231-6e10-46c6-8411-7001dd67e9e1', name: 'Default-Squad' },
  ],
};

describe('remnawaveUserResponseSchema (create / revoke)', () => {
  it('парсит живой ответ панели, лишние поля отбрасывает', () => {
    const parsed = remnawaveUserResponseSchema.parse({ response: LIVE_USER });
    expect(parsed.response.uuid).toBe('dd971f3c-9332-4821-9337-9ca95682758c');
    expect(parsed.response.shortUuid).toBe('4wXbnJkbCGcZDKPP');
    expect(parsed.response.subscriptionUrl).toBe(
      'https://sub.mxpkn8ns.ru/api/sub/4wXbnJkbCGcZDKPP',
    );
    expect(parsed.response.status).toBe('ACTIVE');
    expect(parsed.response.expireAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
    // Внутренние поля панели не протаскиваем (vlessUuid ≠ рабочий id).
    expect('vlessUuid' in parsed.response).toBe(false);
  });

  it('отвергает битую ссылку-подписку и неизвестный статус', () => {
    expect(
      remnawaveUserResponseSchema.safeParse({
        response: { ...LIVE_USER, subscriptionUrl: 'not-a-url' },
      }).success,
    ).toBe(false);
    expect(
      remnawaveUserResponseSchema.safeParse({
        response: { ...LIVE_USER, status: 'BANNED' },
      }).success,
    ).toBe(false);
  });
});

describe('remnawaveUsersByTelegramIdResponseSchema', () => {
  it('пустой массив — юзера нет (HTTP при этом 200, не 404)', () => {
    const parsed = remnawaveUsersByTelegramIdResponseSchema.parse({ response: [] });
    expect(parsed.response).toHaveLength(0);
  });

  it('массив с юзером парсится', () => {
    const parsed = remnawaveUsersByTelegramIdResponseSchema.parse({ response: [LIVE_USER] });
    expect(parsed.response[0]?.username).toBe('tg_999000111222');
  });
});

describe('remnawaveDeleteResponseSchema', () => {
  it('парсит { response: { isDeleted } }', () => {
    expect(
      remnawaveDeleteResponseSchema.parse({ response: { isDeleted: true } }).response.isDeleted,
    ).toBe(true);
  });
});
