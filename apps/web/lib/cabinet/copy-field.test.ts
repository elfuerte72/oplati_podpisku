import { describe, expect, it, vi } from 'vitest';

import { copyCardField } from './copy-field.ts';

/**
 * Копирование реквизита в листе «Реквизиты карты» (тикеты 07 и 10). Две
 * вещи, которые нельзя сломать: отказ буфера не выдаётся за успех (иначе
 * клиент вставляет на сайт сервиса старое содержимое буфера), и значение
 * реквизита не уходит в телеметрию.
 */

const PAN = '5592680100101726';

describe('copyCardField', () => {
  it('буфер принял — «скопировано», событие с полем и ok=true', async () => {
    const track = vi.fn();
    const result = await copyCardField(
      { field: 'number', value: PAN },
      { copy: async () => true, track },
    );
    expect(result).toBe('copied');
    expect(track).toHaveBeenCalledWith('card_copy', { field: 'number', ok: true });
  });

  it('буфер отказал — «не скопировано», а не успех', async () => {
    const track = vi.fn();
    const result = await copyCardField(
      { field: 'cvc', value: '167' },
      { copy: async () => false, track },
    );
    expect(result).toBe('failed');
    expect(track).toHaveBeenCalledWith('card_copy', { field: 'cvc', ok: false });
  });

  it('значение реквизита не попадает в телеметрию ни в каком виде', async () => {
    const track = vi.fn();
    await copyCardField({ field: 'number', value: PAN }, { copy: async () => true, track });
    await copyCardField(
      { field: 'address', value: '201 W 36th Ave' },
      { copy: async () => false, track },
    );
    const sent = JSON.stringify(track.mock.calls);
    expect(sent).not.toContain(PAN);
    expect(sent).not.toContain('201 W 36th Ave');
  });

  it('в буфер уходит именно значение', async () => {
    const copy = vi.fn(async () => true);
    await copyCardField({ field: 'exp', value: '06/27' }, { copy, track: vi.fn() });
    expect(copy).toHaveBeenCalledWith('06/27');
  });
});
