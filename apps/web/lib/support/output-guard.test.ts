import { describe, expect, it } from 'vitest';

import { guardModelOutput } from './output-guard';

/**
 * Выходной фильтр (спека §5). Промпт — просьба к модели, фильтр — гарантия:
 * запрещённое слово в ответе клиент не увидит, даже если модель его сказала.
 */

describe('guardModelOutput — имена партнёров', () => {
  it.each(['PaySpace', 'pay.space', 'Freekassa', 'FreeKassa', 'Love&Pay', 'LoveAndPay', 'Rapira'])(
    '«%s» в ответе — утечка',
    (name) => {
      const res = guardModelOutput(`Карту выпускает ${name}, не волнуйтесь.`);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.category).toBe('partner');
    },
  );

  it('регистр не спасает', () => {
    expect(guardModelOutput('оплата идёт через FREEKASSA').ok).toBe(false);
  });
});

describe('guardModelOutput — страна выпуска карты', () => {
  it.each([
    'Это американская карта, всё пройдёт.',
    'Карта выпущена в США.',
    'У вас карта US-банка.',
    'карта европейского банка',
    'виртуальная карта Великобритании',
  ])('«%s» — утечка', (text) => {
    const res = guardModelOutput(text);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.category).toBe('country');
  });

  it.each(['карта с бонусом bonus 10 %'.replace(' %', ''), 'картой оплатите на сайте: status ok', 'карта Spotify — statusbar'])(
    'РЕГРЕСС V5: «%s» — «us» внутри латинского слова не страна',
    (text) => {
      expect(guardModelOutput(text).ok).toBe(true);
    },
  );

  it('РЕГРЕСС V5: а «us» отдельным словом рядом с картой — по-прежнему утечка', () => {
    expect(guardModelOutput('карта — us bank').ok).toBe(false);
    expect(guardModelOutput('карта US-аккаунта').ok).toBe(false);
  });

  it('страна БЕЗ слова «карта» рядом — не утечка (сервис может быть американским)', () => {
    expect(guardModelOutput('Netflix — американский сервис, у него свои правила.').ok).toBe(true);
  });
});

describe('guardModelOutput — процент и курс', () => {
  it.each([
    'Наша комиссия 30%.',
    'Комиссия составляет 10 процентов.',
    'Курс сегодня 81 рубль за доллар.',
    'Считаем по курсу USDT.',
    'Формула: цена × курс + комиссия.',
  ])('«%s» — утечка', (text) => {
    const res = guardModelOutput(text);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.category).toBe('pricing');
  });

  it('сумма в рублях и надбавка за выпуск — разрешены', () => {
    expect(guardModelOutput('Итого 1 190 ₽: подписка 866 ₽ и выпуск карты 324 ₽.').ok).toBe(true);
  });

  it('«100%» как оборот речи всё равно режется — проще, чем различать', () => {
    expect(guardModelOutput('Я на 100% уверен.').ok).toBe(false);
  });
});

describe('guardModelOutput — внутренние статусы', () => {
  it.each([
    'Ваш заказ в статусе payment_review.',
    'Статус: pending_payment',
    'Заказ перешёл в in_fulfillment',
    'ready_for_payment',
    'handoff_mode = operator',
  ])('«%s» — утечка', (text) => {
    const res = guardModelOutput(text);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.category).toBe('internal');
  });

  it('обычное подчёркивание в тексте не считается статусом', () => {
    expect(guardModelOutput('Введите e_mail без пробелов.').ok).toBe(true);
  });
});

describe('guardModelOutput — модель и инфраструктура', () => {
  it.each([
    'Я работаю на DeepSeek.',
    'Меня сделала Anthropic.',
    'Я Claude, языковая модель.',
    'Я GPT-4.',
    'Наш сервер на VPS в Германии.',
    'Postgres временно недоступен.',
  ])('«%s» — утечка', (text) => {
    expect(guardModelOutput(text).ok).toBe(false);
  });
});

describe('guardModelOutput — чистый ответ проходит', () => {
  it.each([
    'Здравствуйте! Карта придёт в Telegram сразу после оплаты.',
    'Цена фиксируется на 2 часа. Счёт живёт 1 час.',
    'Для Spotify нужен VPN с локацией США.',
    'Реквизиты карты — в приложении, повторно в чате их не выдаю.',
    'Передаю оператору.',
    '',
  ])('«%s»', (text) => {
    expect(guardModelOutput(text)).toEqual({ ok: true });
  });

  it('VPN-локация из инструкции сервиса — разрешена (это не страна КАРТЫ)', () => {
    // Спека §5: «VPN-локация из payment_instructions называть можно».
    expect(guardModelOutput('Включите VPN, локация — США, и попробуйте снова.').ok).toBe(true);
  });
});
