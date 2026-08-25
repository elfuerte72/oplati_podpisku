import { describe, expect, it } from 'vitest';

import { fulfillmentCapacityText } from './capacity.ts';

/**
 * Текст отказа «карту сейчас выпустить нечем» — единственное, что видит клиент
 * по этому сценарию. Требования владельца (2026-08-25): дружелюбно, без
 * технических подробностей и без «на нашей стороне»; про баланс, фонд и
 * провайдера — ни слова.
 */
describe('fulfillmentCapacityText', () => {
  it('говорит по-человечески, без техподробностей и без «на нашей стороне»', () => {
    const text = fulfillmentCapacityText(43);

    expect(text).toMatch(/заминка/i);
    expect(text).not.toMatch(/на нашей стороне/i);
    expect(text).not.toMatch(/технические работы/i);
    expect(text).not.toMatch(/баланс|фонд|PaySpace|карт/i);
  });

  it('обращение на «вы» — во всех ветках текста', () => {
    // Решение владельца 2026-08-25. ⚠️ Остальные тексты продукта на «ты»:
    // если начнёте переводить их, этот не забудьте.
    for (const text of [
      fulfillmentCapacityText(43),
      fulfillmentCapacityText(5),
      fulfillmentCapacityText(null),
    ]) {
      expect(text).not.toMatch(/\bпопробуй\b|\bнапиши\b|за тобой/i);
      expect(text).toMatch(/попробуйте|напишите/i);
    }
  });

  it('называет РЕАЛЬНЫЙ остаток фиксации цены и зовёт вернуться', () => {
    // Решение В3: у заказа могло остаться десять минут, и зашитое «цена
    // держится два часа» стало бы обманом.
    const text = fulfillmentCapacityText(43);

    expect(text).toContain('43 минуты');
    expect(text).toMatch(/попробуйте/i);
    expect(text).toMatch(/поддержк/i);
  });

  it('времени в обрез — зовёт в поддержку СРАЗУ, а не «через 10-15 минут»', () => {
    // Иначе фраза спорит сама с собой: клиент вернётся, когда цена уже
    // протухла, и получит «оформи заказ заново».
    const text = fulfillmentCapacityText(5);

    expect(text).toContain('5 минут');
    expect(text).not.toContain('10-15 минут');
    expect(text).toMatch(/поддержк/i);
  });

  it('на границе запаса ещё зовёт вернуться самому', () => {
    expect(fulfillmentCapacityText(20)).toContain('10-15 минут');
    expect(fulfillmentCapacityText(19)).not.toContain('10-15 минут');
  });

  it('срока нет — про цену молчим, но шаг называем', () => {
    // Обещать «цена за тобой ещё N минут», не зная N, нельзя; звать вернуться —
    // можно.
    const text = fulfillmentCapacityText(null);

    expect(text).toMatch(/попробуйте/i);
    expect(text).not.toMatch(/Цена за вами/i);
  });

  it('склонение живое: минуту / минуты / минут', () => {
    expect(fulfillmentCapacityText(21)).toContain('21 минуту');
    expect(fulfillmentCapacityText(43)).toContain('43 минуты');
    expect(fulfillmentCapacityText(45)).toContain('45 минут');
    expect(fulfillmentCapacityText(12)).toContain('12 минут');
  });
});
