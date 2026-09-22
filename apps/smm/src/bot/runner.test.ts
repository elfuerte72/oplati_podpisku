import { describe, expect, it } from 'vitest';

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../logger.ts';
import { ARTICLE_HTML } from '../sources/fixtures.ts';
import type { Fetcher } from '../sources/index.ts';
import type { Model, ModelResult } from '../llm/model.ts';
import { smmConfig, type ModelRole } from '../config/smm.config.ts';
import { DOSSIER, GOOD_DRAFT, judgePass, THREADS_POST, THREADS_SINGLE_POST } from '../pipeline/fixtures.ts';
import type { SendApi, SendOptions } from '../render/send.ts';
import { openStore, textShaOf, type Store } from '../store/index.ts';
import type { HandoffMessage } from '../threads/handoff.ts';
import { createRunner, type HandoffTarget } from './runner.ts';

const OWNER = 379_336_096;
const CHANNEL = '-1004257122135';

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function fakeModel(answers: Partial<Record<ModelRole, unknown[]>>): Model {
  const queues = new Map<ModelRole, unknown[]>(
    Object.entries(answers).map(([role, list]) => [role as ModelRole, [...(list ?? [])]]),
  );
  function next(role: ModelRole): ModelResult<never> {
    const value = queues.get(role)?.shift();
    if (value === undefined) return { ok: false, reason: 'api_error', message: `нет фикстуры ${role}` };
    return { ok: true, value: value as never };
  }
  return {
    json(role) {
      return Promise.resolve(next(role));
    },
    markdown(role) {
      return Promise.resolve(next(role) as ModelResult<string>);
    },
  };
}

interface Sent {
  readonly method: string;
  readonly chatId: string | number;
  readonly options: SendOptions & { caption?: string };
}

function fakeApi(): { api: SendApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const api: SendApi = {
    sendRichMessage(chatId, _rich, options) {
      sent.push({ method: 'sendRichMessage', chatId, options });
      return Promise.resolve({ message_id: 501 });
    },
    sendPhoto(chatId, _photo, options) {
      sent.push({ method: 'sendPhoto', chatId, options });
      return Promise.resolve({ message_id: 502 });
    },
    sendMessage(chatId, _text, options) {
      sent.push({ method: 'sendMessage', chatId, options });
      return Promise.resolve({ message_id: 503 });
    },
  };
  return { api, sent };
}

interface HandedOff {
  readonly messages: readonly HandoffMessage[];
  readonly target: HandoffTarget;
}

interface SetupExtras {
  readonly mediaDir?: string;
  readonly fetcher?: Fetcher;
}

function setup(answers: Partial<Record<ModelRole, unknown[]>> = {}, extras: SetupExtras = {}) {
  const store = openStore({ path: ':memory:' });
  const { api, sent } = fakeApi();
  const handed: HandedOff[] = [];
  const runner = createRunner({
    store,
    handoff(messages, target) {
      handed.push({ messages, target });
      return Promise.resolve();
    },
    pipeline: { model: fakeModel(answers), logger: silent() },
    api,
    logger: silent(),
    ownerId: OWNER,
    ownerChatId: OWNER,
    channelId: CHANNEL,
    ...(extras.mediaDir === undefined ? {} : { mediaDir: extras.mediaDir }),
    ...(extras.fetcher === undefined
      ? {}
      : { resolve: { fetcher: extras.fetcher, resolver: () => Promise.resolve(['93.184.216.34']) } }),
  });
  return { store, runner, sent, handed };
}

function readyPost(store: Store, body = GOOD_DRAFT): string {
  const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a' });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.patch(post.id, { body, sourceUrl: 'https://example.com/a' });
  return post.id;
}

describe('превью', () => {
  it('уходит ВЛАДЕЛЬЦУ и переводит пост в «показан»', async () => {
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    expect(sent[0]?.chatId).toBe(OWNER);
    expect(store.posts.get(postId)?.status).toBe('previewed');
    expect(store.posts.get(postId)?.previewedAt).toBeDefined();
    store.close();
  });

  it('повторный показ обновляет момент показа', async () => {
    const { store, runner } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    const first = store.posts.get(postId)?.previewedAt;
    await runner.preview(postId);
    const second = store.posts.get(postId)?.previewedAt;
    expect(second).toBeDefined();
    expect(Date.parse(second ?? '')).toBeGreaterThanOrEqual(Date.parse(first ?? ''));
    store.close();
  });
});

describe('публикация', () => {
  it('БЕЗ подтверждения владельца в канал не уходит', async () => {
    // Второй слой защиты: даже если автомат пришлёт эффект, гейт стоит здесь.
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    const result = await runner.publish(postId);
    expect(result.ok).toBe(false);
    expect(sent.filter((item) => item.chatId === CHANNEL)).toHaveLength(0);
    store.close();
  });

  it('с подтверждением уходит в канал и запоминает message_id', async () => {
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    const post = store.posts.get(postId);
    store.posts.transition({
      id: postId,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: post?.textSha ?? '' },
    });

    const result = await runner.publish(postId);
    expect(result.ok).toBe(true);
    const published = store.posts.get(postId);
    expect(published?.status).toBe('published');
    expect(published?.channelMessageId).toBe(503);
    expect(sent.some((item) => item.chatId === CHANNEL)).toBe(true);
    store.close();
  });

  it('подтверждение ЧУЖИМ id не пускает в канал', async () => {
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    const post = store.posts.get(postId);
    store.posts.transition({
      id: postId,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', actorId: 999, textSha: post?.textSha ?? '' },
    });
    const result = await runner.publish(postId);
    expect(result.ok).toBe(false);
    expect(sent.filter((item) => item.chatId === CHANNEL)).toHaveLength(0);
    store.close();
  });

  it('подтверждение под ДРУГИМ текстом не пускает в канал', async () => {
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    store.posts.transition({
      id: postId,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: textShaOf('совсем другой текст') },
    });
    const result = await runner.publish(postId);
    expect(result.ok).toBe(false);
    expect(sent.filter((item) => item.chatId === CHANNEL)).toHaveLength(0);
    store.close();
  });
});

describe('шаг источника', () => {
  it('бренд Оплатишки — отказ без создания поста', async () => {
    const { store, runner } = setup();
    const event = await runner.runStep('source', { input: 'напиши про кнопку в Оплатишке' });
    expect(event).toMatchObject({ kind: 'pipeline_failed', reason: 'product_is_human' });
    expect(store.posts.listByStatus(['draft'])).toHaveLength(0);
    store.close();
  });

  it('ссылка на Telegram — отказ', async () => {
    const { store, runner } = setup();
    const event = await runner.runStep('source', { input: 'https://t.me/durov/1' });
    expect(event).toMatchObject({ kind: 'pipeline_failed', reason: 'telegram_post_not_source' });
    store.close();
  });
});

describe('шаг написания', () => {
  it('пишет тело, переводит статусы и отдаёт отпечаток', async () => {
    const { store, runner } = setup({ write: [GOOD_DRAFT], judge: [judgePass()] });
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.patch(post.id, { dossier: DOSSIER });

    const event = await runner.runStep('produce', {
      postId: post.id,
      rubric: 'news',
      angle: 'Проверь у себя',
    });

    expect(event).toMatchObject({ kind: 'pipeline_done' });
    const stored = store.posts.get(post.id);
    expect(stored?.status).toBe('reviewed');
    expect(stored?.body).toBe(GOOD_DRAFT);
    expect(stored?.textSha).toBe(textShaOf(GOOD_DRAFT));
    expect(stored?.judge).toBeDefined();
    store.close();
  });

  it('провал модели отдаётся событием, а пост остаётся черновиком', async () => {
    const { store, runner } = setup({});
    const post = store.posts.create({ platform: 'telegram' });
    store.posts.patch(post.id, { dossier: DOSSIER });
    const event = await runner.runStep('produce', { postId: post.id, rubric: 'news', angle: 'угол' });
    expect(event).toMatchObject({ kind: 'pipeline_failed', reason: 'model_failed' });
    expect(store.posts.get(post.id)?.status).toBe('draft');
    store.close();
  });
});

describe('гонка публикации', () => {
  it('два одновременных вызова отправляют пост в канал ОДИН раз', async () => {
    const { store, runner, sent } = setup();
    const postId = readyPost(store);
    await runner.preview(postId);
    const post = store.posts.get(postId);
    store.posts.transition({
      id: postId,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: post?.textSha ?? '' },
    });

    const [first, second] = await Promise.all([runner.publish(postId), runner.publish(postId)]);

    expect(sent.filter((item) => item.chatId === CHANNEL)).toHaveLength(1);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    store.close();
  });
});

describe('ветка Threads', () => {
  function threadsSetup() {
    return setup({
      threads: [THREADS_POST],
      judge: [judgePass(smmConfig.judge.threads.criteria)],
    });
  }

  it('ОДИНОЧНЫЙ пост со ссылкой проходит линт: это дефолтный случай', async () => {
    const { store, runner } = setup({
      threads: [THREADS_SINGLE_POST],
      judge: [judgePass(smmConfig.judge.threads.criteria)],
    });
    const post = store.posts.create({ platform: 'threads', dossier: DOSSIER });
    const event = await runner.runStep('produce', { postId: post.id, rubric: 'news', angle: 'память всем' });
    expect(event).toMatchObject({ kind: 'pipeline_done', outcome: { verdict: 'pass' } });
    store.close();
  });

  it('пост площадки пишется своей ролью и получает исход с платформой', async () => {
    const { store, runner } = threadsSetup();
    const post = store.posts.create({ platform: 'threads', dossier: DOSSIER });
    const event = await runner.runStep('produce', { postId: post.id, rubric: 'news', angle: 'память всем' });
    expect(event).toMatchObject({
      kind: 'pipeline_done',
      outcome: { kind: 'post', platform: 'threads', verdict: 'pass' },
    });
    const stored = store.posts.get(post.id);
    // Рекламы у площадки нет: призыв выключается кодом, а не просьбой к модели.
    expect(stored?.cta).toBe('none');
    expect(stored?.tag).toBe('gemini');
    expect(stored?.body).toContain(THREADS_POST.link);
  });

  it('превью площадки уходит ПЕРЕДАЧЕЙ, а не отправкой поста', async () => {
    const { store, runner, sent, handed } = threadsSetup();
    const post = store.posts.create({ platform: 'threads', dossier: DOSSIER });
    await runner.runStep('produce', { postId: post.id, rubric: 'news', angle: 'память всем' });
    await runner.preview(post.id);

    expect(sent).toHaveLength(0);
    expect(handed).toHaveLength(1);
    const first = handed[0]?.messages[0];
    expect(first?.button?.url).toContain('threads.com/intent/post');
    expect(handed[0]?.target.stamp).toBe((store.posts.get(post.id)?.textSha ?? '').slice(0, 8));
    expect(store.posts.get(post.id)?.status).toBe('handed');
  });

  it('«Версия для Threads» берёт СОХРАНЁННОЕ досье, источник заново не читается', async () => {
    const { store, runner } = threadsSetup();
    const parent = store.posts.create({
      platform: 'telegram',
      rubric: 'news',
      dossier: DOSSIER,
      sourceUrl: 'https://blog.example.com/gemini-memory',
    });
    store.posts.patch(parent.id, { angle: 'память всем', body: GOOD_DRAFT });

    const event = await runner.runStep('threads', { parentPostId: parent.id });
    expect(event).toMatchObject({ kind: 'pipeline_done', outcome: { platform: 'threads' } });
    const childId = event?.kind === 'pipeline_done' && event.outcome.kind === 'post' ? event.outcome.postId : '';
    const child = store.posts.get(childId);
    expect(child?.platform).toBe('threads');
    expect(child?.parentPostId).toBe(parent.id);
  });

  it('пост без досье не превращается в версию для Threads молча', async () => {
    const { store, runner } = threadsSetup();
    const parent = store.posts.create({ platform: 'telegram', rubric: 'news' });
    const event = await runner.runStep('threads', { parentPostId: parent.id });
    expect(event).toMatchObject({ kind: 'pipeline_failed', step: 'threads', reason: 'no_dossier' });
  });
});

describe('обложка поста', () => {
  function pages(): Fetcher {
    return (url) => {
      if (url.endsWith('/cover-gemini.jpg')) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
        );
      }
      return Promise.resolve(
        new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    };
  }

  it('картинка источника сохраняется и попадает в пост', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smm-runner-'));
    const { store, runner } = setup({}, { mediaDir: dir, fetcher: pages() });

    const event = await runner.runStep('source', { input: 'https://example.com/post' });
    const postId = event?.kind === 'pipeline_done' && event.outcome.kind === 'article' ? event.outcome.postId : '';
    const saved = store.posts.get(postId)?.imagePath;
    expect(saved).toBeDefined();
    expect(readFileSync(String(saved)).byteLength).toBe(4);
    store.close();
  });

  it('несохранившаяся картинка НЕ роняет шаг: текст уже есть', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smm-runner-'));
    const broken: Fetcher = (url) =>
      url.endsWith('/cover-gemini.jpg')
        ? Promise.resolve(new Response('нет', { status: 404 }))
        : Promise.resolve(
            new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
          );
    const { store, runner } = setup({}, { mediaDir: dir, fetcher: broken });

    const event = await runner.runStep('source', { input: 'https://example.com/post' });
    expect(event).toMatchObject({ kind: 'pipeline_done', outcome: { kind: 'article' } });
    const postId = event?.kind === 'pipeline_done' && event.outcome.kind === 'article' ? event.outcome.postId : '';
    expect(store.posts.get(postId)?.imagePath).toBeUndefined();
    store.close();
  });
});
