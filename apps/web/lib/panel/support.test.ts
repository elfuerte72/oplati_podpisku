import { describe, expect, it } from 'vitest';

import { SUPPORT_BLOCK_TEXT } from './labels';
import { SUPPORT_HISTORY_DAYS, supportReplyBlockReason, supportRoleLabel, supportStateNote } from './support';
import { canReturnToAi } from './permissions';
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
    expect(supportRoleLabel('assistant', null)).toBe('Бот');
    expect(supportRoleLabel('operator', 'Максим')).toBe('Оператор · Максим');
    expect(supportRoleLabel('user', null)).toBe('Клиент');
  });

  it('оператор без имени всё равно оператор', () => {
    expect(supportRoleLabel('operator', null)).toBe('Оператор');
  });

  it('помощник поддержки — отдельная подпись, а не «Бот»', () => {
    // В БД оба — `assistant`. Менеджер обязан видеть, где приветствие
    // Оплатишки, а где ответ ИИ-помощника, который мог ошибиться.
    expect(supportRoleLabel('assistant', null, { source: 'support_ai' })).toBe('Помощник');
    expect(supportRoleLabel('assistant', null, { source: 'static_greeting' })).toBe('Бот');
    expect(supportRoleLabel('assistant', null, null)).toBe('Бот');
  });

  it('служебная строка подписана словом, а не сырой ролью', () => {
    expect(supportRoleLabel('system', null)).toBe('Служебное');
  });

  it('незнакомая роль показывается как есть', () => {
    expect(supportRoleLabel('supervisor', null)).toBe('supervisor');
  });
});

describe('supportStateNote', () => {
  it('переход показывается режимом, триггером и причиной', () => {
    expect(
      supportStateNote({ source: 'support_state', from: 'ai', to: 'operator', trigger: 'hard', reason: 'refund: «возврат»' }),
    ).toBe('Режим: Оператор · жёсткое слово · refund: «возврат»');
  });

  it('без причины — без хвоста', () => {
    expect(supportStateNote({ source: 'support_state', from: 'idle', to: 'ai', trigger: 'button' })).toBe(
      'Режим: Помощник · кнопка «Поддержка»',
    );
  });

  it('РЕГРЕСС финального ревью: у захвата из панели есть подпись, а не сырой ключ', () => {
    // `operator_claim` пишет `claimSupportConversation`; словаря он не знал —
    // менеджер видел бы «operator_claim». Теперь словарь типизирован всем
    // `ConversationModeTrigger`, и пропуск не собирается.
    const note = supportStateNote({ source: 'support_state', from: 'idle', to: 'operator', trigger: 'operator_claim' });
    expect(note).toBe('Режим: Оператор · подключился оператор');
    expect(note).not.toContain('operator_claim');
  });

  it('кто провёл переход руками — отдельным полем, а не «причиной»', () => {
    expect(
      supportStateNote({ source: 'support_state', from: 'operator', to: 'idle', trigger: 'operator_close', actor: 'Менеджер' }),
    ).toBe('Режим: Закрыт · закрыл оператор · Менеджер');
  });

  it('незнакомый триггер показывается как есть, а не прячется', () => {
    expect(supportStateNote({ source: 'support_state', to: 'idle', trigger: 'future_thing' })).toContain(
      'future_thing',
    );
  });

  it('обычная system-строка без нашей meta — null: показывать как есть', () => {
    expect(supportStateNote({ source: 'something_else' })).toBeNull();
    expect(supportStateNote(null)).toBeNull();
  });
});

describe('canReturnToAi', () => {
  it('ведущий может вернуть свой разговор', () => {
    expect(canReturnToAi({ actorId: STAFF, actorRole: 'operator', assignedOperatorId: STAFF })).toBe(true);
  });

  it('чужой разговор вернуть нельзя — решение «я закончил» принимает тот, кто вёл', () => {
    expect(canReturnToAi({ actorId: STAFF, actorRole: 'operator', assignedOperatorId: 'staff-2' })).toBe(
      false,
    );
  });

  it('админ может вернуть любой — сотрудник ушёл в отпуск, а разговор висит', () => {
    expect(canReturnToAi({ actorId: STAFF, actorRole: 'admin', assignedOperatorId: 'staff-2' })).toBe(true);
  });

  it('свободный разговор (эскалация без захвата) вернуть может любой с правом', () => {
    expect(canReturnToAi({ actorId: STAFF, actorRole: 'operator', assignedOperatorId: null })).toBe(true);
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
