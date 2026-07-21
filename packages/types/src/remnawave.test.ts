import { describe, expect, it } from 'vitest';

import {
  remnawaveDeleteResponseSchema,
  remnawaveUserResponseSchema,
  remnawaveUsersByTelegramIdResponseSchema,
} from './remnawave.ts';

/**
 * Контракт Remnawave. ФОРМА фикстуры — сокращённый живой ответ панели
 * (снят 2026-07-21: create 201 / by-telegram-id 200 / revoke 200 / delete
 * 200), но все идентификаторы синтетические — реальные shortUuid/ссылки в
 * репозиторий не кладём даже мёртвыми (находка ревью).
 */

const LIVE_USER = {
  uuid: '11111111-2222-4333-8444-555555555555',
  id: 8,
  shortUuid: 'TESTshortUuid001',
  username: 'tg_999000111222',
  status: 'ACTIVE',
  trafficLimitBytes: 0,
  trafficLimitStrategy: 'MONTH',
  expireAt: '2026-08-21T00:00:00.000Z',
  telegramId: 999000111222,
  email: null,
  vlessUuid: '66666666-7777-4888-8999-000000000000',
  subRevokedAt: null,
  createdAt: '2026-07-21T15:42:45.202Z',
  subscriptionUrl: 'https://sub.example.com/api/sub/TESTshortUuid001',
  activeInternalSquads: [
    { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Default-Squad' },
  ],
};

describe('remnawaveUserResponseSchema (create / revoke)', () => {
  it('парсит живой ответ панели, лишние поля отбрасывает', () => {
    const parsed = remnawaveUserResponseSchema.parse({ response: LIVE_USER });
    expect(parsed.response.uuid).toBe('11111111-2222-4333-8444-555555555555');
    expect(parsed.response.shortUuid).toBe('TESTshortUuid001');
    expect(parsed.response.subscriptionUrl).toBe(
      'https://sub.example.com/api/sub/TESTshortUuid001',
    );
    expect(parsed.response.status).toBe('ACTIVE');
    expect(parsed.response.expireAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
    expect(parsed.response.trafficLimitBytes).toBe(0);
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
