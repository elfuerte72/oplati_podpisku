import { describe, expect, it } from 'vitest';

import {
  SUPPORT_BLOCK_TEXT,
  SUPPORT_HISTORY_DAYS,
  supportReplyBlockReason,
  supportRoleLabel,
} from './support';
import { MESSAGES_RETENTION_DAYS } from '@/lib/retention-policy';

const STAFF = 'staff-1';

describe('supportReplyBlockReason', () => {
  it('свободный диалог с достижимым клиентом — отвечать можно', () => {
    expect(
      supportReplyBlockReason({
        clientTelegramId: '555',
        assignedOperatorId: null,
        actorId: STAFF,
      }),
    ).toBeNull();
  });

  it('свой диалог отвечать не мешает', () => {
    expect(
      supportReplyBlockReason({
        clientTelegramId: '555',
        assignedOperatorId: STAFF,
        actorId: STAFF,
      }),
    ).toBeNull();
  });

  it('клиенту без Telegram поле ответа не показывается', () => {
    // 47 из 103 клиентов без telegram_id: он писал с сайта, и обратного адреса
    // у нас нет. Поле ответа тут — обещание, которое некому исполнить.
    expect(
      supportReplyBlockReason({
        clientTelegramId: null,
        assignedOperatorId: null,
        actorId: STAFF,
      }),
    ).toBe('no_telegram');
  });

  it('чужой диалог закрыт: двое одному клиенту не отвечают', () => {
    expect(
      supportReplyBlockReason({
        clientTelegramId: '555',
        assignedOperatorId: 'staff-2',
        actorId: STAFF,
      }),
    ).toBe('assigned_to_other');
  });

  it('недостижимость важнее занятости: сначала главное', () => {
    expect(
      supportReplyBlockReason({
        clientTelegramId: null,
        assignedOperatorId: 'staff-2',
        actorId: STAFF,
      }),
    ).toBe('no_telegram');
  });

  it('у каждой причины есть объясняющий текст', () => {
    // Пустое место вместо поля ответа — загадка, из-за которой менеджер решит,
    // что панель сломана.
    expect(SUPPORT_BLOCK_TEXT.no_telegram).toContain('Telegram');
    expect(SUPPORT_BLOCK_TEXT.assigned_to_other).toContain('сотрудник');
  });
});

describe('supportRoleLabel', () => {
  it('бот и оператор различаются', () => {
    // Клиент их не различает, а менеджер обязан видеть, где ответил автомат.
    expect(supportRoleLabel('assistant', null)).toBe('бот');
    expect(supportRoleLabel('operator', 'Максим')).toBe('оператор · Максим');
    expect(supportRoleLabel('user', null)).toBe('клиент');
  });

  it('оператор без имени всё равно оператор', () => {
    expect(supportRoleLabel('operator', null)).toBe('оператор');
  });

  it('незнакомая роль показывается как есть', () => {
    expect(supportRoleLabel('system', null)).toBe('system');
  });
});

describe('SUPPORT_HISTORY_DAYS', () => {
  it('это переэкспорт общей политики хранения, а не копия числа', () => {
    // ⚠️ Тождество здесь ничего не доказывает (это буквально один и тот же
    // символ), и проверять его бессмысленно. Смысл теста — зафиксировать, что
    // экран объясняет обрыв ленты ТЕМ ЖЕ сроком, которым живёт крон: если
    // кто-то заменит переэкспорт литералом, значение разъедется с
    // `lib/jobs/retention.ts` молча.
    expect(SUPPORT_HISTORY_DAYS).toBe(MESSAGES_RETENTION_DAYS);
    expect(Number.isInteger(SUPPORT_HISTORY_DAYS)).toBe(true);
  });
});
