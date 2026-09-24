import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.ts';
import type { Fetcher } from '../sources/index.ts';
import { openStore, type Store } from '../store/index.ts';
import { collectViews, parseViews, parseWidgetViews, WITHDRAW_MISSES } from './views.ts';

const publicDns = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function widget(posts: { id: number; views?: string }[]): string {
  const blocks = posts
    .map(
      (post) => `<div class="tgme_widget_message" data-post="ooplatishka/${post.id}">
  <div class="tgme_widget_message_footer">
    ${post.views === undefined ? '' : `<span class="tgme_widget_message_views">${post.views}</span>`}
  </div>
</div>`,
    )
    .join('\n');
  return `<!doctype html><html><body><section>${blocks}</section></body></html>`;
}

function serve(html: string): Fetcher {
  return () =>
    Promise.resolve(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
}

/** Опубликованный пост с известным номером сообщения в канале. */
function publishedPost(store: Store, messageId: number, publishedAt: string): string {
  const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a' });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.transition({
    id: post.id,
    from: ['reviewed'],
    to: 'previewed',
    decision: { kind: 'preview', actor: 'code' },
    patch: { body: '# Заголовок\n\nтело' },
  });
  store.posts.transition({
    id: post.id,
    from: ['previewed'],
    to: 'approved',
    decision: { kind: 'approve', actor: 'owner', actorId: 1, textSha: store.posts.get(post.id)?.textSha ?? '' },
  });
  store.posts.transition({
    id: post.id,
    from: ['approved'],
    to: 'published',
    decision: { kind: 'publish', actor: 'code' },
    patch: { channelMessageId: messageId },
  });
  // Витрина сверяет возраст по времени публикации: ставим его руками.
  store.db.run('UPDATE posts SET published_at = ? WHERE id = ?', publishedAt, post.id);
  return post.id;
}

describe('счётчик витрины', () => {
  it('понимает сокращения и обе роли запятой', () => {
    expect(parseViews('1,234')).toBe(1234);
    expect(parseViews('1,2K')).toBe(1200);
    expect(parseViews('1.2K')).toBe(1200);
    expect(parseViews('12.3K')).toBe(12_300);
    expect(parseViews('834')).toBe(834);
    expect(parseViews('1M')).toBe(1_000_000);
    expect(parseViews('мусор')).toBeUndefined();
  });

  it('сопоставляет номер поста со счётчиком', () => {
    const map = parseWidgetViews(widget([{ id: 10, views: '1.2K' }, { id: 11 }]));
    expect(map.get(10)).toBe(1200);
    expect(map.has(11)).toBe(false);
  });
});

describe('сбор просмотров', () => {
  const OLD = '2026-09-01T00:00:00.000Z';
  const NOW = new Date('2026-09-22T10:00:00.000Z');

  it('пишет снимок по номеру сообщения', async () => {
    const store = openStore({ path: ':memory:' });
    const postId = publishedPost(store, 10, OLD);

    const result = await collectViews({
      store,
      logger: silent(),
      channel: { key: 'main', username: 'ooplatishka' },
      http: { fetcher: serve(widget([{ id: 10, views: '1.2K' }])), resolver: publicDns },
      now: () => NOW,
    });

    expect(result.recorded).toBe(1);
    expect(store.views.latest(postId)?.views).toBe(1200);
    store.close();
  });

  it('снятым пост становится только после ДВУХ пропусков', async () => {
    const store = openStore({ path: ':memory:' });
    const postId = publishedPost(store, 10, OLD);
    // Соседи по странице есть с обеих сторон: пост пропал из середины, а не
    // уехал за границу страницы.
    const empty = {
      fetcher: serve(widget([{ id: 9, views: '100' }, { id: 11, views: '100' }])),
      resolver: publicDns,
    };

    const first = await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: empty, now: () => NOW });
    expect(first.withdrawn).toEqual([]);
    expect(store.posts.get(postId)?.status).toBe('published');

    const second = await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: empty, now: () => NOW });
    expect(second.withdrawn).toEqual([postId]);
    expect(store.posts.get(postId)?.status).toBe('withdrawn');
    expect(WITHDRAW_MISSES).toBe(2);
    store.close();
  });

  it('свежий пост не хоронится, даже если его нет на витрине', async () => {
    const store = openStore({ path: ':memory:' });
    const postId = publishedPost(store, 10, '2026-09-22T08:00:00.000Z');
    const empty = { fetcher: serve(widget([])), resolver: publicDns };

    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: empty, now: () => NOW });
    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: empty, now: () => NOW });

    expect(store.posts.get(postId)?.status).toBe('published');
    store.close();
  });

  it('появившийся снова пост обнуляет счётчик пропусков', async () => {
    const store = openStore({ path: ':memory:' });
    const postId = publishedPost(store, 10, OLD);
    const gone = {
      fetcher: serve(widget([{ id: 9, views: '100' }, { id: 11, views: '100' }])),
      resolver: publicDns,
    };
    const back = { fetcher: serve(widget([{ id: 10, views: '500' }])), resolver: publicDns };

    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: gone, now: () => NOW });
    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: back, now: () => NOW });
    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: gone, now: () => NOW });

    expect(store.posts.get(postId)?.status).toBe('published');
    store.close();
  });

  it('пост, уехавший за границу СТРАНИЦЫ витрины, не хоронится', async () => {
    const store = openStore({ path: ':memory:' });
    // Старый пост (номер 10) уже не помещается на страницу: витрина отдаёт
    // последние сообщения, и его отсутствие означает «страница кончилась», а
    // не «пост удалили».
    const old = publishedPost(store, 10, OLD);
    const fresh = publishedPost(store, 120, OLD);
    const page = { fetcher: serve(widget([{ id: 118, views: '10' }, { id: 120, views: '20' }])), resolver: publicDns };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: page, now: () => NOW });
    }

    expect(store.posts.get(old)?.status).toBe('published');
    expect(store.posts.get(fresh)?.status).toBe('published');
    store.close();
  });

  it('пост ВНУТРИ страницы, которого на ней нет, хоронится', async () => {
    const store = openStore({ path: ':memory:' });
    const removed = publishedPost(store, 119, OLD);
    const page = { fetcher: serve(widget([{ id: 118, views: '10' }, { id: 120, views: '20' }])), resolver: publicDns };

    await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: page, now: () => NOW });
    const second = await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: page, now: () => NOW });

    expect(second.withdrawn).toEqual([removed]);
    store.close();
  });

  it('недоступная витрина НЕ хоронит посты', async () => {
    const store = openStore({ path: ':memory:' });
    const postId = publishedPost(store, 10, OLD);
    const broken: Fetcher = () => Promise.resolve(new Response('нет', { status: 500 }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await collectViews({
        store,
        logger: silent(),
        channel: { key: 'main', username: 'ooplatishka' },
        http: { fetcher: broken, resolver: publicDns },
        now: () => NOW,
      });
      expect(result.failed).toBeDefined();
    }
    expect(store.posts.get(postId)?.status).toBe('published');
    store.close();
  });
});

describe('просмотры по каналам', () => {
  const OLD = '2026-09-01T00:00:00.000Z';
  const NOW = new Date('2026-09-24T10:00:00.000Z');

  it('пост второго канала не читается с витрины основного и не хоронится ею', async () => {
    const store = openStore({ path: ':memory:' });
    const main = publishedPost(store, 10, OLD);
    // Номер 10 занят основным каналом: во второй канал пост уходит одним патчем
    // с его собственным номером 10 — у каналов свои счётчики.
    const second = publishedPost(store, 99, OLD);
    store.posts.patch(second, { channel: 'second', channelMessageId: 10 });
    // Витрина основного канала: номер 10 есть, соседи тоже — второй канал со
    // своим номером 10 тут ни при чём.
    const page = {
      fetcher: serve(widget([{ id: 9, views: '50' }, { id: 10, views: '1.2K' }, { id: 11, views: '70' }])),
      resolver: publicDns,
    };
    for (let round = 0; round < 3; round += 1) {
      await collectViews({ store, logger: silent(), channel: { key: 'main', username: 'ooplatishka' }, http: page, now: () => NOW });
    }
    expect(store.views.latest(main)?.views).toBe(1200);
    expect(store.views.latest(second)).toBeUndefined();
    expect(store.posts.get(second)?.status).toBe('published');

    // И наоборот: на витрине второго канала поста основного нет — это не повод его хоронить.
    const secondPage = {
      fetcher: serve(widget([{ id: 9, views: '5' }, { id: 11, views: '7' }])),
      resolver: publicDns,
    };
    for (let round = 0; round < 3; round += 1) {
      await collectViews({ store, logger: silent(), channel: { key: 'second', username: 'aibromotion' }, http: secondPage, now: () => NOW });
    }
    expect(store.posts.get(main)?.status).toBe('published');
    expect(store.posts.get(second)?.status).toBe('withdrawn');
    store.close();
  });
});
