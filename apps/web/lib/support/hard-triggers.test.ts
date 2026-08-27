import { describe, expect, it } from 'vitest';

import { matchHardTrigger } from './hard-triggers';

/**
 * Жёсткие триггеры эскалации (спека §8, утверждены владельцем).
 *
 * Детерминированный список, проверяется ДО вызова модели. Ошибка в сторону
 * человека принята осознанно: лишняя передача оператору дешевле, чем клиент,
 * которого модель уговаривает не просить возврат.
 */

describe('matchHardTrigger — человек', () => {
  it.each([
    'позовите оператора',
    'Оператора!',
    'нужен менеджер',
    'хочу поговорить с человеком',
    'дайте живого человека',
    'живой человек есть?',
    'сотрудника позовите',
    'operator please',
  ])('«%s» → human', (text) => {
    expect(matchHardTrigger(text)?.category).toBe('human');
  });

  it('падежи и регистр не мешают', () => {
    expect(matchHardTrigger('ОПЕРАТОРУ передайте')?.category).toBe('human');
    expect(matchHardTrigger('менеджером')?.category).toBe('human');
  });

  it('отрицание СРАБАТЫВАЕТ — ложное срабатывание в сторону человека принято', () => {
    expect(matchHardTrigger('оператор не нужен, сам разберусь')?.category).toBe('human');
  });
});

describe('matchHardTrigger — деньги назад', () => {
  it.each([
    'хочу возврат',
    'сделайте возврат средств',
    'верните деньги',
    'верни деньги!',
    'хочу вернуть деньги',
    'отдайте деньги обратно',
    'refund please',
    'это chargeback',
    'сделаю чарджбек',
    'отмените платёж',
    'отмени платеж',
  ])('«%s» → refund', (text) => {
    expect(matchHardTrigger(text)?.category).toBe('refund');
  });

  it('«ё» и «е» в «платёж» равноправны', () => {
    expect(matchHardTrigger('отмените платеж')?.category).toBe('refund');
    expect(matchHardTrigger('отмените платёж')?.category).toBe('refund');
  });
});

describe('matchHardTrigger — претензия и угроза', () => {
  it.each([
    'вы мошенники',
    'это мошенничество',
    'это обман',
    'меня кинули',
    'какой-то развод',
    'напишу жалобу',
    'подам в суд',
    'обращусь в полицию',
    'напишу в прокуратуру',
    'пожалуюсь в роскомнадзор',
  ])('«%s» → complaint', (text) => {
    expect(matchHardTrigger(text)?.category).toBe('complaint');
  });
});

describe('matchHardTrigger — юрлицо и документы', () => {
  it.each([
    'дайте реквизиты',
    'нужен договор',
    'скажите ИНН',
    'ваш ОГРН',
    'оплата от юрлица',
    'нужно для бухгалтерии',
    'закрывающие документы',
    'счёт-фактуру пришлите',
    'счет-фактура нужна',
    'чек для отчётности',
  ])('«%s» → legal', (text) => {
    expect(matchHardTrigger(text)?.category).toBe('legal');
  });
});

describe('matchHardTrigger — не срабатывает', () => {
  it.each([
    'когда придёт карта?',
    'оставлю отзыв',
    'отзывы у вас хорошие',
    'сколько стоит Spotify',
    'не проходит оплата на сайте',
    'спасибо, всё понятно',
    '',
  ])('«%s» → null', (text) => {
    expect(matchHardTrigger(text)).toBeNull();
  });

  it('«отзыв» не триггер — двусмысленно (решение владельца)', () => {
    expect(matchHardTrigger('хочу оставить отзыв')).toBeNull();
    expect(matchHardTrigger('отзыв о вас')).toBeNull();
  });

  it('«чек» сам по себе — не документы: чек об оплате — обычный вопрос', () => {
    expect(matchHardTrigger('где чек об оплате?')).toBeNull();
  });

  it.each([
    'судя по всему, всё прошло',
    'меня зовут Иннокентий',
    'договорились, жду',
    'посуда тут ни при чём',
  ])('РЕГРЕСС V4: «%s» — ДРУГОЕ слово с той же основой НЕ триггер', (text) => {
    expect(matchHardTrigger(text)).toBeNull();
  });

  it('«обманчиво» и «разводной» — срабатывают: это префикс утверждённой основы, ошибка в сторону человека принята', () => {
    // Спека §8: отрицание срабатывает, ложное срабатывание в сторону человека
    // принято владельцем. Граница ставится ТОЛЬКО слева — русская морфология
    // делает основу префиксом слова, и отсекать справа значило бы терять
    // «обманули», «разводят».
    expect(matchHardTrigger('это обманчиво просто')?.category).toBe('complaint');
    expect(matchHardTrigger('разводной ключ не нужен')?.category).toBe('complaint');
  });

  it('РЕГРЕСС V4: а настоящие слова с этими основами — по-прежнему триггер', () => {
    expect(matchHardTrigger('подам в суд')?.category).toBe('complaint');
    expect(matchHardTrigger('это обман')?.category).toBe('complaint');
    expect(matchHardTrigger('нужен договор')?.category).toBe('legal');
    expect(matchHardTrigger('скажите ИНН')?.category).toBe('legal');
    expect(matchHardTrigger('судебный иск')?.category).toBe('complaint');
  });
});

describe('matchHardTrigger — результат', () => {
  it('возвращает совпавшую основу для причины оператору', () => {
    const hit = matchHardTrigger('хочу возврат средств');
    expect(hit).toEqual({ category: 'refund', matched: 'возврат' });
  });

  it('при нескольких совпадениях берётся первое по порядку категорий', () => {
    // «оператор» (human) идёт раньше «возврат» (refund) — категории упорядочены
    // по тому, что важнее оператору знать первым.
    expect(matchHardTrigger('оператор, хочу возврат')?.category).toBe('human');
  });
});
