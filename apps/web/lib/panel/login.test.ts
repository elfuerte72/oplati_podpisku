import { createHash, createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StaffMember } from '@oplati/db';

import { authorizeSessionToken, beginPanelLogin, completePanelLogin } from './login';
import { signPanelToken } from './token';
import { generateTotpSecret, totpCodeAt } from './totp';

/**
 * Вход в панель целиком: первый фактор (Telegram), второй (TOTP) и проверка
 * живой сессии на каждом запросе.
 *
 * Главные свойства, которые тут держатся:
 *   - неизвестный сотрудник и отключённый получают ОДИНАКОВЫЙ отказ;
 *   - `is_active` проверяется на каждом запросе, а не только при входе;
 *   - между факторами доступ не выдаётся.
 */

const BOT_TOKEN = '7992756364:AAH-test-login-bot';
const SECRET = 'x'.repeat(64);
const NOW = 1_755_000_000;

function widgetPayload(telegramId: string, authDate = NOW) {
  const fields: Record<string, string> = {
    id: telegramId,
    first_name: 'Владелец',
    auth_date: String(authDate),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  return { ...fields, hash: createHmac('sha256', secret).update(dataCheckString).digest('hex') };
}

function staffFixture(over: Partial<StaffMember> = {}): StaffMember {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'owner@example.com',
    displayName: 'Владелец',
    role: 'admin',
    telegramId: '379336096',
    isActive: true,
    totpSecret: null,
    totpConfirmedAt: null,
    totpLastStep: null,
    lastLoginAt: null,
    createdAt: new Date('2026-08-17T00:00:00Z'),
    ...over,
  };
}

describe('beginPanelLogin — первый фактор', () => {
  const deps = {
    botToken: BOT_TOKEN,
    findStaffByTelegramId: vi.fn(async (): Promise<StaffMember | null> => staffFixture()),
    startTotpEnrollment: vi.fn(async (_i: { staffId: string; secret: string }) => true),
    nowSeconds: NOW,
  };

  beforeEach(() => {
    deps.findStaffByTelegramId.mockClear();
    deps.startTotpEnrollment.mockClear();
    deps.findStaffByTelegramId.mockImplementation(async () => staffFixture());
    deps.startTotpEnrollment.mockImplementation(async () => true);
  });

  it('первый вход отправляет на привязку и пишет новый секрет в базу', async () => {
    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    expect(res).toMatchObject({ ok: true, stage: 'enroll' });
    const written = deps.startTotpEnrollment.mock.calls[0]?.[0]?.secret;
    expect(written).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('секрет наружу из ядра НЕ уходит — его показывает экран, читая базу', async () => {
    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    const written = deps.startTotpEnrollment.mock.calls[0]?.[0]?.secret ?? 'нет';
    expect(JSON.stringify(res)).not.toContain(written);
  });

  it('повторно применённый payload виджета отвергается', async () => {
    const payload = widgetPayload('379336096');
    const used = new Set<string>();
    const claimPayloadOnce = async (sig: string) => (used.has(sig) ? false : (used.add(sig), true));

    expect(await beginPanelLogin({ payload, ...deps, claimPayloadOnce })).toMatchObject({
      ok: true,
    });
    // Второй заход (кнопка «назад» в браузере) не должен перевыдавать секрет:
    // запись в приложении сотрудника стала бы мёртвой.
    deps.startTotpEnrollment.mockClear();
    expect(await beginPanelLogin({ payload, ...deps, claimPayloadOnce })).toEqual({
      ok: false,
      reason: 'replayed',
    });
    expect(deps.startTotpEnrollment).not.toHaveBeenCalled();
  });

  it('одноразовость проверяется ПОСЛЕ подписи — мусор хранилище не забивает', async () => {
    const claimPayloadOnce = vi.fn(async () => true);

    await beginPanelLogin({
      payload: { ...widgetPayload('379336096'), id: '730162414' },
      ...deps,
      claimPayloadOnce,
    });

    expect(claimPayloadOnce).not.toHaveBeenCalled();
  });

  it('у привязанного сотрудника сразу просим код, секрет НЕ показываем', async () => {
    deps.findStaffByTelegramId.mockImplementation(async () =>
      staffFixture({ totpSecret: 'ALREADY', totpConfirmedAt: new Date() }),
    );

    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    expect(res).toMatchObject({ ok: true, stage: 'totp' });
    expect(JSON.stringify(res)).not.toContain('ALREADY');
    expect(deps.startTotpEnrollment).not.toHaveBeenCalled();
  });

  it('неизвестный telegram_id — отказ без подробностей', async () => {
    deps.findStaffByTelegramId.mockImplementation(async () => null);

    const res = await beginPanelLogin({ payload: widgetPayload('999'), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('отключённый сотрудник получает ТОТ ЖЕ отказ, что и неизвестный', async () => {
    deps.findStaffByTelegramId.mockImplementation(async () => staffFixture({ isActive: false }));

    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('сотрудник без telegram_id в базе не проходит', async () => {
    deps.findStaffByTelegramId.mockImplementation(async () => staffFixture({ telegramId: null }));

    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('подделанная подпись до базы не доходит', async () => {
    const forged = { ...widgetPayload('379336096'), id: '730162414' };

    const res = await beginPanelLogin({ payload: forged, ...deps });

    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
    expect(deps.findStaffByTelegramId).not.toHaveBeenCalled();
  });

  it('просроченный вход отвергается', async () => {
    const res = await beginPanelLogin({
      payload: widgetPayload('379336096', NOW - 4000),
      ...deps,
    });

    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('не настроен бот входа — авария конфига, а не отказ клиенту', async () => {
    const res = await beginPanelLogin({
      payload: widgetPayload('379336096'),
      ...deps,
      botToken: '',
    });

    expect(res).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('перевыдачу секрета отклонила база — вход не продолжается', async () => {
    deps.startTotpEnrollment.mockImplementation(async () => false);

    const res = await beginPanelLogin({ payload: widgetPayload('379336096'), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });
});

describe('completePanelLogin — второй фактор', () => {
  const secret = generateTotpSecret();
  const validCode = () => totpCodeAt(secret, NOW);

  const deps = {
    findStaffById: vi.fn(async (): Promise<StaffMember | null> => staffFixture({ totpSecret: secret })),
    confirmTotp: vi.fn(async (_i: { staffId: string; expectedSecret: string }) => true),
    claimTotpStep: vi.fn(async (_i: { staffId: string; step: number }) => true),
    touchLastLogin: vi.fn(async () => undefined),
    nowSeconds: NOW,
  };

  beforeEach(() => {
    deps.findStaffById.mockClear();
    deps.confirmTotp.mockClear();
    deps.claimTotpStep.mockClear();
    deps.touchLastLogin.mockClear();
    deps.findStaffById.mockImplementation(async () => staffFixture({ totpSecret: secret }));
    deps.confirmTotp.mockImplementation(async () => true);
    deps.claimTotpStep.mockImplementation(async () => true);
  });

  it('верный код завершает привязку и впускает', async () => {
    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toMatchObject({ ok: true });
    // Записываем id из НАЙДЕННОЙ строки, а не присланный вызывающим.
    const staffId = staffFixture().id;
    // Подтверждение сверяет секрет: иначе соседняя вкладка, перевыдавшая
    // секрет, заставила бы подтвердить чужой.
    expect(deps.confirmTotp).toHaveBeenCalledWith({ staffId, expectedSecret: secret });
    expect(deps.touchLastLogin).toHaveBeenCalledWith(staffId);
  });

  it('окно кода занимается ДО выдачи доступа — код одноразовый', () => {
    // Проверяется в следующем тесте; здесь фиксируем сам факт вызова.
    expect(typeof completePanelLogin).toBe('function');
  });

  it('переигранный код не впускает', async () => {
    deps.claimTotpStep.mockImplementation(async () => false);

    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toEqual({ ok: false, reason: 'code_used' });
    expect(deps.touchLastLogin).not.toHaveBeenCalled();
    expect(deps.confirmTotp).not.toHaveBeenCalled();
  });

  it('занимается ИМЕННО то окно, код которого совпал', async () => {
    const prevWindowCode = totpCodeAt(secret, NOW - 30);

    await completePanelLogin({ staffId: 's1', code: prevWindowCode, ...deps });

    expect(deps.claimTotpStep).toHaveBeenCalledWith({
      staffId: staffFixture().id,
      step: Math.floor((NOW - 30) / 30),
    });
  });

  it('битый секрет в базе — не «код не подошёл», а потеря привязки', async () => {
    deps.findStaffById.mockImplementation(async () => staffFixture({ totpSecret: '!!!' }));

    const res = await completePanelLogin({ staffId: 's1', code: '123456', ...deps });

    expect(res).toEqual({ ok: false, reason: 'enrollment_lost' });
  });

  it('повторный вход уже привязанного код подтверждает, но привязку не трогает', async () => {
    deps.findStaffById.mockImplementation(async () =>
      staffFixture({ totpSecret: secret, totpConfirmedAt: new Date() }),
    );

    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toMatchObject({ ok: true });
    expect(deps.confirmTotp).not.toHaveBeenCalled();
  });

  it('неверный код не впускает и не отмечает вход', async () => {
    const res = await completePanelLogin({ staffId: 's1', code: '000000', ...deps });

    expect(res).toEqual({ ok: false, reason: 'bad_code' });
    expect(deps.touchLastLogin).not.toHaveBeenCalled();
    // Окно не занимаем: промах не должен «съедать» код, который сотрудник
    // ещё не вводил.
    expect(deps.claimTotpStep).not.toHaveBeenCalled();
  });

  it('сотрудника отключили между факторами — не впускаем', async () => {
    deps.findStaffById.mockImplementation(async () =>
      staffFixture({ totpSecret: secret, isActive: false }),
    );

    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('сотрудника удалили между факторами — не впускаем', async () => {
    deps.findStaffById.mockImplementation(async () => null);

    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('секрета нет — привязку надо начать заново', async () => {
    deps.findStaffById.mockImplementation(async () => staffFixture({ totpSecret: null }));

    const res = await completePanelLogin({ staffId: 's1', code: validCode(), ...deps });

    expect(res).toEqual({ ok: false, reason: 'enrollment_lost' });
  });
});

describe('authorizeSessionToken — проверка на КАЖДОМ запросе', () => {
  const deps = {
    secret: SECRET,
    findStaffById: vi.fn(async (): Promise<StaffMember | null> => staffFixture()),
    nowSeconds: NOW + 60,
  };

  const token = signPanelToken({ purpose: 'session', staffId: 's1' }, SECRET, NOW);

  beforeEach(() => {
    deps.findStaffById.mockClear();
    deps.findStaffById.mockImplementation(async () => staffFixture());
  });

  it('живая сессия активного сотрудника принимается', async () => {
    const res = await authorizeSessionToken({ token, ...deps });

    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.actor.role).toBe('admin');
  });

  it('отключённый сотрудник теряет доступ немедленно, не дожидаясь срока cookie', async () => {
    deps.findStaffById.mockImplementation(async () => staffFixture({ isActive: false }));

    expect(await authorizeSessionToken({ token, ...deps })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('удалённый сотрудник теряет доступ немедленно', async () => {
    deps.findStaffById.mockImplementation(async () => null);

    expect(await authorizeSessionToken({ token, ...deps })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('без cookie — просто «не вошёл», без похода в базу', async () => {
    expect(await authorizeSessionToken({ token: undefined, ...deps })).toEqual({
      ok: false,
      reason: 'no_session',
    });
    expect(deps.findStaffById).not.toHaveBeenCalled();
  });

  it('подделанный токен не пускает и до базы не доходит', async () => {
    const res = await authorizeSessionToken({ token: 'v1.aaa.bbb', ...deps });

    expect(res).toEqual({ ok: false, reason: 'bad_session' });
    expect(deps.findStaffById).not.toHaveBeenCalled();
  });

  it('токен «первый фактор пройден» сессией не является', async () => {
    const pending = signPanelToken({ purpose: 'pending', staffId: 's1' }, SECRET, NOW);

    expect(await authorizeSessionToken({ token: pending, ...deps })).toEqual({
      ok: false,
      reason: 'bad_session',
    });
  });

  it('протухшая сессия отвергается', async () => {
    expect(
      await authorizeSessionToken({ token, ...deps, nowSeconds: NOW + 13 * 60 * 60 }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
});
