import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDb } from './db.ts';
import { openStore, type Store } from './index.ts';

/** Часы, которыми управляет тест: окна, порядок решений и метки времени проверяются, а не угадываются. */
function clock(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    now: (): Date => new Date(current),
    tick(ms: number): void {
      current += ms;
    },
  };
}

function freshStore(startIso = '2026-09-22T10:00:00.000Z'): { store: Store; time: ReturnType<typeof clock> } {
  const time = clock(startIso);
  const store = openStore({ path: ':memory:', now: time.now });
  return { store, time };
}

describe('миграции', () => {
  it('применяются один раз и повторный прогон идемпотентен', () => {
    const db = openDb(':memory:');
    const first = migrate(db);
    expect(first.length).toBeGreaterThan(0);
    const second = migrate(db);
    expect(second).toEqual([]);
    const names = db.all<{ name: string }>('SELECT name FROM migrations ORDER BY name');
    expect(names).toHaveLength(first.length);
    db.close();
  });

  it('создают все таблицы состояния', () => {
    const { store } = freshStore();
    const tables = store.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    for (const table of ['posts', 'decisions', 'flow', 'items', 'usage', 'settings', 'offtopic']) {
      expect(tables, table).toContain(table);
    }
  });
});

describe('журнал решений append-only', () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore().store;
  });

  it('UPDATE по decisions бросает', () => {
    const post = store.posts.create({ platform: 'telegram', brief: 'тема' });
    expect(store.posts.decisions(post.id).length).toBeGreaterThan(0);
    expect(() => store.db.run("UPDATE decisions SET kind = 'approve' WHERE post_id = ?", post.id)).toThrowError(
      /append-only/,
    );
  });

  it('DELETE по decisions бросает', () => {
    const post = store.posts.create({ platform: 'telegram' });
    expect(() => store.db.run('DELETE FROM decisions WHERE post_id = ?', post.id)).toThrowError(
      /append-only/,
    );
  });
});

describe('переходы поста', () => {
  it('переход из верного статуса пишет решение и метку времени', () => {
    const { store, time } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    time.tick(1000);

    const result = store.posts.transition({
      id: post.id,
      from: ['draft'],
      to: 'linted',
      decision: { kind: 'lint', actor: 'code', payload: { errors: 0 } },
      patch: { body: '# Заголовок', textSha: 'sha1' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.status).toBe('linted');
    expect(result.post.body).toBe('# Заголовок');
    expect(result.post.updatedAt).toBe('2026-09-22T10:00:01.000Z');
    const kinds = store.posts.decisions(post.id).map((d) => d.kind);
    expect(kinds).toContain('lint');
  });

  it('переход из неверного статуса не состоялся и вернул ФАКТИЧЕСКИЙ статус', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    const before = store.posts.decisions(post.id).length;

    const result = store.posts.transition({
      id: post.id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha1' },
    });

    expect(result).toEqual({ ok: false, actual: 'draft' });
    // Решение НЕ записано: иначе журнал утверждал бы то, чего не было.
    expect(store.posts.decisions(post.id)).toHaveLength(before);
    expect(store.posts.get(post.id)?.status).toBe('draft');
  });

  it('патч из несостоявшегося перехода не применяется', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.transition({
      id: post.id,
      from: ['approved'],
      to: 'published',
      decision: { kind: 'publish', actor: 'code' },
      patch: { channelMessageId: 4242 },
    });
    expect(store.posts.get(post.id)?.channelMessageId).toBeUndefined();
  });

  it('несуществующий пост даёт actual = null, а не выдуманный статус', () => {
    const { store } = freshStore();
    const result = store.posts.transition({
      id: 'нет-такого',
      from: ['draft'],
      to: 'linted',
      decision: { kind: 'lint', actor: 'code' },
    });
    expect(result).toEqual({ ok: false, actual: null });
  });

  it('переход, не описанный машиной, бросает: это ошибка кода, а не гонка', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    expect(() =>
      store.posts.transition({
        id: post.id,
        from: ['draft'],
        to: 'published',
        decision: { kind: 'publish', actor: 'code' },
      }),
    ).toThrowError(/не разрешён машиной статусов/);
  });

  it('метки времени ставит сам переход', () => {
    const { store, time } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
    time.tick(60_000);
    store.posts.transition({
      id: post.id,
      from: ['reviewed'],
      to: 'previewed',
      decision: { kind: 'preview', actor: 'code' },
      patch: { textSha: 'sha1' },
    });
    expect(store.posts.get(post.id)?.previewedAt).toBe('2026-09-22T10:01:00.000Z');

    time.tick(60_000);
    store.posts.transition({
      id: post.id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha1' },
    });
    time.tick(60_000);
    store.posts.transition({
      id: post.id,
      from: ['approved'],
      to: 'published',
      decision: { kind: 'publish', actor: 'code' },
      patch: { channelMessageId: 10 },
    });
    const published = store.posts.get(post.id);
    expect(published?.publishedAt).toBe('2026-09-22T10:03:00.000Z');
    expect(published?.channelMessageId).toBe(10);
    expect(store.posts.findByMessageId(10)?.id).toBe(post.id);
  });
});

describe('гейт публикации', () => {
  function previewedPost(store: Store, sha = 'sha1') {
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
    store.posts.transition({
      id: post.id,
      from: ['reviewed'],
      to: 'previewed',
      decision: { kind: 'preview', actor: 'code' },
      patch: { body: 'тело', textSha: sha },
    });
    return post.id;
  }

  it('без решения владельца публиковать нельзя', () => {
    const { store } = freshStore();
    const id = previewedPost(store);
    expect(store.posts.isApprovedForPublish(id)).toBe(false);
  });

  it('approve от владельца с тем же отпечатком после превью — можно', () => {
    const { store, time } = freshStore();
    const id = previewedPost(store);
    time.tick(5000);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha1' },
    });
    expect(store.posts.isApprovedForPublish(id)).toBe(true);
  });

  it('approve с ЧУЖИМ отпечатком не считается', () => {
    // Владелец нажал «Опубликовать» под старым текстом, а после этого пост
    // переписали: подтверждение относилось к другим словам.
    const { store, time } = freshStore();
    const id = previewedPost(store, 'sha1');
    time.tick(5000);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha-старый' },
    });
    expect(store.posts.isApprovedForPublish(id)).toBe(false);
  });

  it('правка текста после подтверждения снимает право на публикацию', () => {
    const { store, time } = freshStore();
    const id = previewedPost(store, 'sha1');
    time.tick(1000);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha1' },
    });
    expect(store.posts.isApprovedForPublish(id)).toBe(true);
    store.posts.patch(id, { body: 'другое тело', textSha: 'sha2' });
    expect(store.posts.isApprovedForPublish(id)).toBe(false);
  });

  it('решение, записанное ДО показа превью, не считается', () => {
    // Повторный показ превью обновляет previewed_at: старое «да» устаревает.
    const { store, time } = freshStore();
    const id = previewedPost(store, 'sha1');
    time.tick(1000);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', textSha: 'sha1' },
    });
    time.tick(1000);
    store.posts.transition({
      id,
      from: ['approved'],
      to: 'previewed',
      decision: { kind: 'cancel', actor: 'owner' },
    });
    expect(store.posts.isApprovedForPublish(id)).toBe(false);
  });

  it('approve не от владельца (например от кода) не считается', () => {
    const { store, time } = freshStore();
    const id = previewedPost(store);
    time.tick(1000);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'code', textSha: 'sha1' },
    });
    expect(store.posts.isApprovedForPublish(id)).toBe(false);
  });
});

describe('выборки постов', () => {
  it('последние вышедшие посты площадки идут свежими первыми', () => {
    const { store, time } = freshStore();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const post = store.posts.create({ platform: 'telegram' });
      store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
      store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
      store.posts.transition({
        id: post.id,
        from: ['reviewed'],
        to: 'previewed',
        decision: { kind: 'preview', actor: 'code' },
        patch: { textSha: `sha${i}` },
      });
      store.posts.transition({
        id: post.id,
        from: ['previewed'],
        to: 'approved',
        decision: { kind: 'approve', actor: 'owner', textSha: `sha${i}` },
      });
      store.posts.transition({
        id: post.id,
        from: ['approved'],
        to: 'published',
        decision: { kind: 'publish', actor: 'code' },
      });
      ids.push(post.id);
      time.tick(60_000);
    }

    const recent = store.posts.recentPublished({ platform: 'telegram' });
    expect(recent.map((p) => p.id)).toEqual([...ids].reverse());
    expect(store.posts.recentPublished({ platform: 'telegram', excludeId: ids[2] }).map((p) => p.id)).toEqual(
      [ids[1], ids[0]],
    );
    // Посты Threads в историю канала не попадают: у них другой читатель.
    expect(store.posts.recentPublished({ platform: 'threads' })).toEqual([]);
  });

  it('черновики в работе видны по статусам, свежие первыми', () => {
    const { store, time } = freshStore();
    const first = store.posts.create({ platform: 'telegram' });
    time.tick(1000);
    const second = store.posts.create({ platform: 'telegram' });
    expect(store.posts.listByStatus(['draft']).map((p) => p.id)).toEqual([second.id, first.id]);
    expect(store.posts.listByStatus([])).toEqual([]);
  });

  it('зависший в статусе пост находится по времени входа', () => {
    const { store, time } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    time.tick(20 * 60_000);
    const cutoff = new Date(Date.parse('2026-09-22T10:00:00.000Z') + 15 * 60_000).toISOString();
    expect(store.posts.stuckInStatus('draft', cutoff).map((p) => p.id)).toEqual([post.id]);
    const earlier = new Date(Date.parse('2026-09-22T09:59:00.000Z')).toISOString();
    expect(store.posts.stuckInStatus('draft', earlier)).toEqual([]);
  });

  it('JSON-поля читаются обратно объектами', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram', dossier: { facts: ['a'] } });
    store.posts.patch(post.id, { judge: { mean: 4.3, verdict: 'pass' } });
    const stored = store.posts.get(post.id);
    expect(stored?.dossier).toEqual({ facts: ['a'] });
    expect(stored?.judge).toEqual({ mean: 4.3, verdict: 'pass' });
  });

  it('пустой патч не роняет и не двигает updated_at в неизвестность', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    expect(store.posts.patch(post.id, {})?.updatedAt).toBe(post.updatedAt);
  });

  it('publishAt можно снять null-ом', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.patch(post.id, { publishAt: '2026-09-22T10:01:00.000Z' });
    expect(store.posts.get(post.id)?.publishAt).toBe('2026-09-22T10:01:00.000Z');
    store.posts.patch(post.id, { publishAt: null });
    expect(store.posts.get(post.id)?.publishAt).toBeUndefined();
  });
});

describe('состояние диалога', () => {
  it('пишется, перезаписывается и снимается', () => {
    const { store, time } = freshStore();
    expect(store.flow.get(1)).toBeUndefined();
    store.flow.set(1, { state: 'post.await_input', expiresAt: '2026-09-23T10:00:00.000Z' });
    expect(store.flow.get(1)?.state).toBe('post.await_input');
    time.tick(1000);
    store.flow.set(1, { state: 'post.await_rubric', postId: 'p1', payload: { angles: 3 } });
    const row = store.flow.get(1);
    expect(row?.state).toBe('post.await_rubric');
    expect(row?.postId).toBe('p1');
    expect(row?.payload).toEqual({ angles: 3 });
    // Перезапись не оставляет прежний срок: иначе новое ожидание унаследовало бы
    // чужой дедлайн.
    expect(row?.expiresAt).toBeUndefined();
    store.flow.clear(1);
    expect(store.flow.get(1)).toBeUndefined();
  });
});

describe('элементы источников', () => {
  it('дедуп по адресу: повтор обновляет заголовок, но не стирает решение', () => {
    const { store, time } = freshStore();
    const item = store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://a/1', title: 'Первый' });
    store.items.markVerdict(item.id, 'offtopic');
    store.items.setRank(item.id, { relevance: 4 });
    time.tick(1000);
    const again = store.items.upsertByUrl({
      sourceKind: 'telegram',
      url: 'https://a/1',
      title: 'Уточнённый',
    });
    expect(again.id).toBe(item.id);
    expect(again.title).toBe('Уточнённый');
    expect(again.verdict).toBe('offtopic');
    expect(again.rank).toEqual({ relevance: 4 });
  });

  it('повтор без заголовка не затирает известный', () => {
    const { store } = freshStore();
    store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://a/2', title: 'Есть' });
    const again = store.items.upsertByUrl({ sourceKind: 'hn', url: 'https://a/2' });
    expect(again.title).toBe('Есть');
  });

  it('свежие элементы отдаются по окну и без решения владельца', () => {
    const { store, time } = freshStore();
    store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://a/old', title: 'Старый' });
    time.tick(3 * 60 * 60_000);
    const fresh = store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://a/new', title: 'Новый' });
    store.items.markVerdict(fresh.id, 'written');
    const since = new Date(Date.parse('2026-09-22T11:00:00.000Z')).toISOString();
    expect(store.items.listRecent({ sinceIso: since }).map((i) => i.url)).toEqual(['https://a/new']);
    expect(store.items.listRecent({ onlyUnjudged: true }).map((i) => i.url)).toEqual(['https://a/old']);
  });
});

describe('расход на модель', () => {
  it('считается по календарному месяцу UTC и по ролям', () => {
    const { store, time } = freshStore('2026-08-31T23:59:59.000Z');
    store.usage.add({
      role: 'write',
      model: 'deepseek-flash',
      inputTokens: 1000,
      outputTokens: 500,
      cacheHitTokens: 0,
      usdMicros: 450,
      isPeak: false,
      priceKnown: true,
    });
    time.tick(2000); // уже сентябрь
    store.usage.add({
      role: 'write',
      model: 'deepseek-flash',
      inputTokens: 2000,
      outputTokens: 1000,
      cacheHitTokens: 100,
      usdMicros: 900,
      isPeak: true,
      priceKnown: true,
    });
    store.usage.add({
      role: 'judge',
      model: 'deepseek-flash',
      inputTokens: 500,
      outputTokens: 200,
      cacheHitTokens: 0,
      usdMicros: 195,
      isPeak: false,
      priceKnown: false,
    });

    const august = store.usage.sumByMonth('2026-08');
    expect(august.usdMicros).toBe(450);
    expect(august.calls).toBe(1);

    const september = store.usage.sumByMonth('2026-09');
    expect(september.usdMicros).toBe(1095);
    expect(september.calls).toBe(2);
    expect(september.byRole.map((r) => r.role)).toEqual(['write', 'judge']);
    // Неизвестный тариф помечается: число в /stats тогда оценочное.
    expect(september.hasUnknownPrice).toBe(true);
    expect(august.hasUnknownPrice).toBe(false);
  });

  it('месяц в неверном формате отвергается', () => {
    const { store } = freshStore();
    expect(() => store.usage.sumByMonth('сентябрь')).toThrowError(/yyyy-mm/);
  });

  it('вызов без поста (ранжирование) пишется с пустым post_id', () => {
    const { store } = freshStore();
    store.usage.add({
      role: 'rank',
      model: 'deepseek-flash',
      inputTokens: 10,
      outputTokens: 10,
      cacheHitTokens: 0,
      usdMicros: 5,
      isPeak: false,
      priceKnown: true,
    });
    expect(store.usage.countSince('2026-09-22T00:00:00.000Z')).toBe(1);
  });
});

describe('настройки', () => {
  const digest = z.object({ enabled: z.boolean(), hourMsk: z.number().int().min(0).max(23) });

  it('пишутся и читаются по схеме', () => {
    const { store } = freshStore();
    expect(store.settings.get('digest', digest)).toBeUndefined();
    store.settings.set('digest', digest, { enabled: true, hourMsk: 10 });
    expect(store.settings.get('digest', digest)).toEqual({ enabled: true, hourMsk: 10 });
    expect(store.settings.keys()).toEqual(['digest']);
  });

  it('негодное значение в базе не выдаётся за настоящее', () => {
    const { store } = freshStore();
    store.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('digest', '{\"enabled\":\"да\"}', '2026-09-22T10:00:00.000Z')",
    );
    const reasons: string[] = [];
    expect(store.settings.get('digest', digest, (reason) => reasons.push(reason))).toBeUndefined();
    expect(reasons).toHaveLength(1);
  });

  it('негодное значение не попадает в базу на записи', () => {
    const { store } = freshStore();
    expect(() => store.settings.set('digest', digest, { enabled: true, hourMsk: 42 })).toThrow();
    expect(store.settings.keys()).toEqual([]);
  });

  it('снятие настройки возвращает поведение к дефолту кода', () => {
    const { store } = freshStore();
    store.settings.set('digest', digest, { enabled: false, hourMsk: 9 });
    store.settings.remove('digest');
    expect(store.settings.get('digest', digest)).toBeUndefined();
  });
});

describe('список «не по теме»', () => {
  it('пополняется и отдаётся свежими первыми', () => {
    const { store } = freshStore();
    store.offtopic.add('  криптобиржи  ');
    store.offtopic.add('политика');
    store.offtopic.add('   ');
    expect(store.offtopic.list()).toEqual(['политика', 'криптобиржи']);
  });
});

describe('транзакция', () => {
  it('откат снимает и переход, и решение', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram' });
    const before = store.posts.decisions(post.id).length;
    expect(() =>
      store.transaction(() => {
        store.posts.transition({
          id: post.id,
          from: ['draft'],
          to: 'linted',
          decision: { kind: 'lint', actor: 'code' },
        });
        throw new Error('сбой после перехода');
      }),
    ).toThrowError(/сбой после перехода/);
    expect(store.posts.get(post.id)?.status).toBe('draft');
    expect(store.posts.decisions(post.id)).toHaveLength(before);
  });
});
