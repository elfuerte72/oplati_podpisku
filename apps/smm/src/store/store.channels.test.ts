import { describe, expect, it } from 'vitest';

import { openStore, textShaOf, type Store } from './index.ts';

/** Telegram id владельца в тестах: гейт публикации сверяет именно его. */
const OWNER = 379_336_096;

function freshStore(): { store: Store; tick: (ms: number) => void } {
  let current = new Date('2026-09-24T10:00:00.000Z').getTime();
  const store = openStore({ path: ':memory:', now: () => new Date(current) });
  return {
    store,
    tick: (ms) => {
      current += ms;
    },
  };
}

function previewed(store: Store, body = 'тело поста', origin: 'owner' | 'auto' = 'owner'): string {
  const post = store.posts.create({ platform: 'telegram', origin });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.transition({
    id: post.id,
    from: ['reviewed'],
    to: 'previewed',
    decision: { kind: 'preview', actor: 'code' },
    patch: { body },
  });
  return post.id;
}

describe('каналы и автодрафты (миграция 0004)', () => {
  it('номер сообщения уникален внутри канала, а не на все каналы', () => {
    const { store } = freshStore();
    const a = store.posts.create({ platform: 'telegram' });
    const b = store.posts.create({ platform: 'telegram' });
    store.posts.patch(a.id, { channel: 'main', channelMessageId: 7 });
    // Тот же номер во ВТОРОМ канале — законно: у каналов свои счётчики.
    store.posts.patch(b.id, { channel: 'second', channelMessageId: 7 });
    expect(store.posts.findByMessageId('second', 7)?.id).toBe(b.id);
    expect(store.posts.findByMessageId('main', 7)?.id).toBe(a.id);
    // А в том же канале — нет: сторож просмотров пометил бы снятым не тот пост.
    const c = store.posts.create({ platform: 'telegram' });
    expect(() => store.posts.patch(c.id, { channel: 'main', channelMessageId: 7 })).toThrow();
  });

  it('копия «в оба» проходит тот же гейт публикации, что исходник', () => {
    const { store, tick } = freshStore();
    const id = previewed(store);
    const sha = textShaOf('тело поста');
    tick(1000);
    const approve = { kind: 'approve' as const, actor: 'owner' as const, actorId: OWNER, textSha: sha };
    store.posts.transition({ id, from: ['previewed'], to: 'approved', decision: approve, patch: { channel: 'main' } });

    const copy = store.posts.createChannelCopy({
      sourceId: id,
      channel: 'second',
      approve,
      publishAt: '2026-09-24T10:01:00.000Z',
    });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.post).toMatchObject({
      status: 'approved',
      channel: 'second',
      parentPostId: id,
      body: 'тело поста',
      textSha: sha,
      publishAt: '2026-09-24T10:01:00.000Z',
    });
    expect(store.posts.isApprovedForPublish(copy.post.id, OWNER)).toBe(true);
    expect(store.posts.channelCopies(id).map((p) => p.id)).toEqual([copy.post.id]);
  });

  it('копия с чужим отпечатком не создаётся: владелец подтверждал другой текст', () => {
    const { store } = freshStore();
    const id = previewed(store);
    const copy = store.posts.createChannelCopy({
      sourceId: id,
      channel: 'second',
      approve: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: textShaOf('другой текст') },
    });
    expect(copy.ok).toBe(false);
    expect(store.posts.channelCopies(id)).toEqual([]);
  });

  it('неразобранные автодрафты — только ПОКАЗАННЫЕ владельцу, по площадке', () => {
    const { store } = freshStore();
    previewed(store, 'а', 'auto');
    previewed(store, 'б', 'auto');
    previewed(store, 'в', 'owner');
    // Застрявший на сборке черновик ждёт уборки, а не решения: потолок он не забивает.
    store.posts.create({ platform: 'telegram', origin: 'auto' });
    const rejected = previewed(store, 'г', 'auto');
    store.posts.transition({
      id: rejected,
      from: ['previewed'],
      to: 'rejected',
      decision: { kind: 'reject', actor: 'owner', actorId: OWNER },
    });
    expect(store.posts.countPendingAuto('telegram')).toBe(2);
    expect(store.posts.countPendingAuto('threads')).toBe(0);
  });

  it('идею берут в работу один раз, она уходит из выборки и возвращается по release', () => {
    const { store } = freshStore();
    const item = store.items.upsertByUrl({ sourceKind: 'rss', url: 'https://news.example/a', title: 'A' });
    expect(store.items.claim(item.id)).toBe(true);
    expect(store.items.claim(item.id)).toBe(false);
    expect(store.items.findById(item.id)?.takenAt).toBeDefined();
    expect(store.items.listRecent({ onlyNotTaken: true })).toEqual([]);
    expect(store.items.listRecent({}).map((i) => i.id)).toEqual([item.id]);
    store.items.release(item.id);
    expect(store.items.claim(item.id)).toBe(true);
  });

  it('копия без НАСТОЯЩЕГО решения владельца на исходнике не создаётся', () => {
    // Иначе гейт копии замыкался бы на себя: код пишет решение и сам его проверяет.
    const { store } = freshStore();
    const id = previewed(store);
    const copy = store.posts.createChannelCopy({
      sourceId: id,
      channel: 'second',
      approve: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: textShaOf('тело поста') },
    });
    expect(copy.ok).toBe(false);
    expect(store.posts.channelCopies(id)).toEqual([]);
  });

  it('пост «в оба» в статистике содержания — один пост, в счётчиках каналов — свой каждому', () => {
    const { store, tick } = freshStore();
    const id = previewed(store);
    store.posts.patch(id, { rubric: 'news' });
    const sha = textShaOf('тело поста');
    tick(1000);
    const approve = { kind: 'approve' as const, actor: 'owner' as const, actorId: OWNER, textSha: sha };
    store.posts.transition({ id, from: ['previewed'], to: 'approved', decision: approve });
    store.posts.transition({
      id,
      from: ['approved'],
      to: 'published',
      decision: { kind: 'publish', actor: 'code' },
      patch: { channel: 'main', channelMessageId: 11 },
    });
    const copy = store.posts.createChannelCopy({ sourceId: id, channel: 'second', approve });
    if (!copy.ok) throw new Error('копия не создалась');
    store.posts.transition({
      id: copy.post.id,
      from: ['approved'],
      to: 'published',
      decision: { kind: 'publish', actor: 'code' },
      patch: { channel: 'second', channelMessageId: 11 },
    });

    // Содержание: рубрика и лента свежести видят ОДИН пост, а не два.
    expect(store.stats.countPublished({ platform: 'telegram' })).toBe(1);
    expect(store.stats.rubricCounts('2026-09-01T00:00:00.000Z')).toEqual([{ rubric: 'news', count: 1 }]);
    expect(store.posts.recentPublished({ platform: 'telegram' }).map((p) => p.id)).toEqual([id]);
    // Каналы: у каждого своя публикация.
    expect(store.stats.countPublished({ channel: 'main' })).toBe(1);
    expect(store.stats.countPublished({ channel: 'second' })).toBe(1);
  });

  it('поле angles хранит варианты угла JSON-ом', () => {
    const { store } = freshStore();
    const post = store.posts.create({ platform: 'telegram', origin: 'auto' });
    const angles = [{ title: 'Дешевле на 40%', idea: 'что это значит' }];
    store.posts.patch(post.id, { angles });
    expect(store.posts.get(post.id)).toMatchObject({ origin: 'auto', angles });
  });
});
