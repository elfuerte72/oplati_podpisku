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
      expect(text).not.toMatch(/\bпопробуй\b|\bнапиши\b/i);
      expect(text).toMatch(/попробуйте|напишите/i);
    }
  });

  it('успокаивает про заказ и называет следующий шаг', () => {
    // Практика сообщений о недоступности сервиса: сказать, что происходит, что
    // с данными клиента всё в порядке, когда вернуться и куда писать, если не
    // вернётся.
    const text = fulfillmentCapacityText(43);

    expect(text).toMatch(/заказ сохранён/i);
    expect(text).toMatch(/попробуйте/i);
    expect(text).toMatch(/поддержк/i);
  });

  it('НЕ рассказывает про срок фиксации цены — клиент про него не знает', () => {
    // Он не выбирал этот таймер и до отказа о нём не слышал. Введи его здесь —
    // и вместо ответа «что делать» человек получает новую тревогу: оказывается,
    // у него что-то истекает. Срок по-прежнему решает, КАКОЙ дать совет, но в
    // текст не попадает.
    for (const minutes of [97, 43, 21, 5, 1]) {
      const text = fulfillmentCapacityText(minutes);
      expect(text).not.toMatch(/цена/i);
      expect(text).not.toMatch(new RegExp(`${minutes}\\s*минут`));
    }
  });

  it('времени в обрез — зовёт в поддержку СРАЗУ, а не «через 10-15 минут»', () => {
    // Вернувшись через десять минут, клиент застал бы протухшую цену и «оформи
    // заказ заново». Причину не объясняем — просто даём другой совет.
    const text = fulfillmentCapacityText(5);

    expect(text).not.toContain('10-15 минут');
    expect(text).toMatch(/поддержк/i);
  });

  it('на границе запаса ещё зовёт вернуться самому', () => {
    expect(fulfillmentCapacityText(20)).toContain('10-15 минут');
    expect(fulfillmentCapacityText(19)).not.toContain('10-15 минут');
  });

  it('срока нет — совет тот же, что и при запасе времени', () => {
    const text = fulfillmentCapacityText(null);

    expect(text).toMatch(/попробуйте/i);
    expect(text).toMatch(/заказ сохранён/i);
  });
});
