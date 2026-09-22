import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openStore, textShaOf, ulid, ulidTime, type Store } from './index.ts';

/**
 * Дыры, названные ревью тикета 02. Отдельным файлом, чтобы каждая проверка
 * объясняла, какой именно способ отказа она закрывает.
 */

function clock(startIso = '2026-09-22T10:00:00.000Z') {
  let current = new Date(startIso).getTime();
  return {
    now: (): Date => new Date(current),
    tick(ms: number): void {
      current += ms;
    },
  };
}

function fresh(startIso?: string): { store: Store; time: ReturnType<typeof clock> } {
  const time = clock(startIso);
  return { store: openStore({ path: ':memory:', now: time.now }), time };
}

describe('вложенная транзакция', () => {
  it('пойманная внутри ошибка откатывает только вложенную часть', () => {
    // Раньше вложенный вызов «переиспользовал» внешнюю транзакцию, и
    // вызывающий считал, что вложенное откатилось, а запись оставалась.
    const { store } = fresh();
    const outer = store.posts.create({ platform: 'telegram' });
    const inner = store.posts.create({ platform: 'telegram' });

    store.transaction(() => {
      store.posts.patch(outer.id, { brief: 'снаружи' });
      try {
        store.transaction(() => {
          store.posts.transition({
            id: inner.id,
            from: ['draft'],
            to: 'linted',
            decision: { kind: 'lint', actor: 'code' },
          });
          throw new Error('сбой внутри вложенной');
        });
      } catch {
        // Вызывающий поймал и продолжил: внешняя часть обязана уцелеть.
      }
    });

    expect(store.posts.get(outer.id)?.brief).toBe('снаружи');
    expect(store.posts.get(inner.id)?.status).toBe('draft');
  });
});

describe('патч поста', () => {
  it('явный undefined колонку не стирает, а null стирает', () => {
    // Без этого правила `patch(id, { body: draft.body })` с пустым значением
    // стирал бы тело и отпечаток молча.
    const { store } = fresh();
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.patch(post.id, { body: 'тело', buttonUrl: 'https://example.com' });
    store.posts.patch(post.id, { body: undefined, buttonUrl: undefined });
    const kept = store.posts.get(post.id);
    expect(kept?.body).toBe('тело');
    expect(kept?.buttonUrl).toBe('https://example.com');
    expect(kept?.textSha).toBe(textShaOf('тело'));
  });

  it('патч несуществующего поста возвращает undefined', () => {
    const { store } = fresh();
    expect(store.posts.patch('нет-такого', { brief: 'x' })).toBeUndefined();
  });

  it('пустой список исходных статусов — ошибка кода, а не «переход не состоялся»', () => {
    const { store } = fresh();
    const post = store.posts.create({ platform: 'telegram' });
    expect(() =>
      store.posts.transition({
        id: post.id,
        from: [],
        to: 'linted',
        decision: { kind: 'lint', actor: 'code' },
      }),
    ).toThrowError(/без списка исходных статусов/);
  });
});

describe('пост Threads', () => {
  it('выложенный пост получает время выхода и попадает в историю площадки', () => {
    const { store, time } = fresh();
    const post = store.posts.create({ platform: 'threads' });
    store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
    store.posts.transition({ id: post.id, from: ['reviewed'], to: 'handed', decision: { kind: 'preview', actor: 'code' }, patch: { body: 'крючок' } });
    time.tick(60_000);
    store.posts.transition({
      id: post.id,
      from: ['handed'],
      to: 'posted',
      decision: { kind: 'threads_posted', actor: 'owner', actorId: 1 },
    });
    const posted = store.posts.get(post.id);
    expect(posted?.publishedAt).toBe('2026-09-22T10:01:00.000Z');
    expect(store.posts.recentPublished({ platform: 'threads' }).map((p) => p.id)).toEqual([post.id]);
    // Правка после выхода не двигает пост в истории площадки.
    time.tick(60_000);
    store.posts.patch(post.id, { brief: 'правка' });
    expect(store.posts.recentPublished({ platform: 'threads' })[0]?.publishedAt).toBe(
      '2026-09-22T10:01:00.000Z',
    );
  });
});

describe('снятый черновик и удалённый пост', () => {
  it('различаются колонками времени', () => {
    const { store } = fresh();
    const draft = store.posts.create({ platform: 'telegram' });
    store.posts.transition({ id: draft.id, from: ['draft'], to: 'rejected', decision: { kind: 'reject', actor: 'owner', actorId: 1 } });
    const rejected = store.posts.get(draft.id);
    expect(rejected?.rejectedAt).toBeDefined();
    // Иначе статистика снятий с витрины посчитала бы зарубленные черновики.
    expect(rejected?.withdrawnAt).toBeUndefined();
  });
});

describe('одно сообщение канала — один пост', () => {
  it('повторная запись того же message_id отвергается базой', () => {
    const { store } = fresh();
    const first = store.posts.create({ platform: 'telegram' });
    const second = store.posts.create({ platform: 'telegram' });
    store.posts.patch(first.id, { channelMessageId: 77 });
    expect(() => store.posts.patch(second.id, { channelMessageId: 77 })).toThrow();
  });
});

describe('состояние диалога', () => {
  it('срок ожидания хранится как есть: вывод делает автомат', () => {
    const { store, time } = fresh();
    store.flow.set(1, { state: 'post.await_input', expiresAt: '2026-09-22T11:00:00.000Z' });
    time.tick(2 * 60 * 60_000);
    // Строка не исчезает и не помечается: погашение — дело диалога, а не
    // хранилища, и считается по времени СОБЫТИЯ, а не по стенным часам.
    expect(store.flow.get(1)?.expiresAt).toBe('2026-09-22T11:00:00.000Z');
    expect(store.flow.get(1)?.state).toBe('post.await_input');
  });

  it('состояние без срока хранится без срока', () => {
    const { store, time } = fresh();
    store.flow.set(1, { state: 'idle' });
    time.tick(30 * 24 * 60 * 60_000);
    // Нет срока — нечему истекать: автомат такое состояние не гасит.
    expect(store.flow.get(1)?.expiresAt).toBeUndefined();
  });
});

describe('расход на модель', () => {
  it('нецелые и отрицательные значения отвергаются, а не округляются', () => {
    // Передадут доллары вместо микродолларов — в базу лёг бы ноль, и месячный
    // счёт занизился бы молча.
    const { store } = fresh();
    const entry = {
      role: 'write',
      model: 'deepseek-flash',
      inputTokens: 10,
      outputTokens: 10,
      cacheHitTokens: 0,
      usdMicros: 100,
      isPeak: false,
      priceKnown: true,
    };
    expect(() => store.usage.add({ ...entry, usdMicros: 0.00045 })).toThrowError(/usdMicros/);
    expect(() => store.usage.add({ ...entry, usdMicros: Number.NaN })).toThrowError(/usdMicros/);
    expect(() => store.usage.add({ ...entry, inputTokens: -1 })).toThrowError(/inputTokens/);
    expect(store.usage.countSince('2026-09-01T00:00:00.000Z')).toBe(0);
  });

  it('месяц вне 01-12 отвергается', () => {
    const { store } = fresh();
    expect(() => store.usage.sumByMonth('2026-13')).toThrowError(/01-12/);
    expect(() => store.usage.sumByMonth('2026-00')).toThrowError(/01-12/);
  });

  it('декабрь считается по своему месяцу, а не заезжает в январь', () => {
    const { store, time } = fresh('2026-12-31T23:00:00.000Z');
    const entry = {
      role: 'write',
      model: 'deepseek-flash',
      inputTokens: 10,
      outputTokens: 10,
      cacheHitTokens: 0,
      usdMicros: 7,
      isPeak: false,
      priceKnown: true,
    };
    store.usage.add(entry);
    time.tick(2 * 60 * 60_000); // уже 2027 год
    store.usage.add(entry);
    expect(store.usage.sumByMonth('2026-12').usdMicros).toBe(7);
    expect(store.usage.sumByMonth('2027-01').usdMicros).toBe(7);
  });

  it('февраль високосного года кончается первым марта', () => {
    const { store, time } = fresh('2028-02-29T23:00:00.000Z');
    const entry = {
      role: 'judge',
      model: 'deepseek-flash',
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
      usdMicros: 3,
      isPeak: false,
      priceKnown: true,
    };
    store.usage.add(entry);
    time.tick(2 * 60 * 60_000);
    store.usage.add(entry);
    expect(store.usage.sumByMonth('2028-02').calls).toBe(1);
    expect(store.usage.sumByMonth('2028-03').calls).toBe(1);
  });
});

describe('элементы и список «не по теме»', () => {
  it('промах по id виден вызывающему', () => {
    const { store } = fresh();
    expect(store.items.markVerdict('нет-такого', 'skipped')).toBe(false);
    expect(store.items.setRank('нет-такого', { relevance: 1 })).toBe(false);
    const item = store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://a/1' });
    expect(store.items.markVerdict(item.id, 'skipped')).toBe(true);
  });

  it('повторная тема «не по теме» не копится дублями', () => {
    const { store } = fresh();
    store.offtopic.add('криптобиржи');
    store.offtopic.add('криптобиржи');
    expect(store.offtopic.list()).toEqual(['криптобиржи']);
  });

  it('первый источник элемента не переписывается вторым', () => {
    const { store } = fresh();
    store.items.upsertByUrl({ sourceKind: 'rss', sourceRef: 'lenta', url: 'https://a/2' });
    const again = store.items.upsertByUrl({ sourceKind: 'telegram', sourceRef: 'канал', url: 'https://a/2' });
    expect(again.sourceKind).toBe('rss');
    expect(again.sourceRef).toBe('lenta');
  });
});

describe('настройки', () => {
  it('негодное значение без обработчика просто не читается', () => {
    const { store } = fresh();
    store.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('x', 'не json', '2026-09-22T10:00:00.000Z')",
    );
    expect(store.settings.get('x', z.number())).toBeUndefined();
  });
});

describe('негодный JSON в колонке', () => {
  it('не роняет чтение поста и сообщается вызывающему', () => {
    const reasons: string[] = [];
    const time = clock();
    const store = openStore({ path: ':memory:', now: time.now, onCorruptJson: (r) => reasons.push(r) });
    const post = store.posts.create({ platform: 'telegram' });
    store.db.run('UPDATE posts SET dossier = ? WHERE id = ?', 'не json', post.id);
    const read = store.posts.get(post.id);
    expect(read?.dossier).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('dossier');
  });
});

describe('ULID', () => {
  it('обратные часы и мусор отвергаются', () => {
    expect(() => ulid(-1)).toThrowError(/ULID/);
    expect(() => ulid(1.5)).toThrowError(/ULID/);
    expect(() => ulid(Number.NaN)).toThrowError(/ULID/);
  });

  it('разбор короткой строки и нижнего регистра отвергается', () => {
    expect(() => ulidTime('01')).toThrowError(/не ULID/);
    expect(() => ulidTime(ulid().toLowerCase())).toThrowError(/не ULID/);
  });
});

describe('закрытие базы', () => {
  it('второй close не бросает', () => {
    const { store } = fresh();
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
