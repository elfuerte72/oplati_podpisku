import { describe, expect, it } from 'vitest';

import { emitDbChange, onDbChange, type DbChange } from './change-feed.ts';

describe('change-feed: уведомления об изменениях таблиц', () => {
  it('подписчик получает таблицу, которую изменил репозиторий', () => {
    const seen: DbChange[] = [];
    const off = onDbChange((change) => seen.push(change));
    try {
      emitDbChange('orders');
      expect(seen).toEqual([{ table: 'orders' }]);
    } finally {
      off();
    }
  });

  it('после отписки уведомления не приходят', () => {
    const seen: DbChange[] = [];
    const off = onDbChange((change) => seen.push(change));
    off();
    emitDbChange('orders');
    expect(seen).toEqual([]);
  });

  it('упавший подписчик не роняет запись и не глушит остальных — ошибка уходит в onError', () => {
    const errors: unknown[] = [];
    const seen: DbChange[] = [];
    const offBroken = onDbChange(
      () => {
        throw new Error('слушатель сломан');
      },
      { onError: (err) => errors.push(err) },
    );
    const offOk = onDbChange((change) => seen.push(change));
    try {
      expect(() => emitDbChange('messages')).not.toThrow();
      expect(seen).toEqual([{ table: 'messages' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('слушатель сломан');
    } finally {
      offBroken();
      offOk();
    }
  });
});
