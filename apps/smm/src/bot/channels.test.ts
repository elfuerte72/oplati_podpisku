import { describe, expect, it } from 'vitest';

import type { ChannelTarget } from '../config/env.ts';
import { TEXTS } from '../dialog/texts.ts';
import { createLogger } from '../logger.ts';
import { GOOD_DRAFT } from '../pipeline/fixtures.ts';
import type { SendApi, SendOptions } from '../render/send.ts';
import { openStore, type Store } from '../store/index.ts';
import {
  approvedChannels,
  buildPreviewControls,
  channelAllows,
  mentionsProduct,
  publishTargets,
} from './channels.ts';
import { createRunner } from './runner.ts';

const OWNER = 379_336_096;
const MAIN: ChannelTarget = {
  key: 'main',
  id: '-1004257122135',
  username: 'ooplatishka',
  title: 'Оплатишка',
  label: 'В Оплатишку',
};
const SECOND: ChannelTarget = {
  key: 'second',
  id: '-1003314281166',
  username: 'aibromotion',
  title: 'Aibromotion',
  label: 'В Aibromotion',
};
const BOTH = [MAIN, SECOND] as const;
const AD_BODY = `${GOOD_DRAFT}\n\nОплатить такую подписку помогает Оплатишка.`;

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

describe('правило рекламы канала', () => {
  it('упоминание Оплатишки или её бота — реклама, в теле или в своей кнопке', () => {
    expect(mentionsProduct({ body: GOOD_DRAFT })).toBe(false);
    expect(mentionsProduct({ body: AD_BODY })).toBe(true);
    expect(mentionsProduct({ body: 'пиши @oplatishkaa_bot' })).toBe(true);
    expect(mentionsProduct({ body: GOOD_DRAFT, buttonUrl: 'https://t.me/oplatishkaa_bot?start=x' })).toBe(true);
  });

  it('канал без рекламы не берёт текст с упоминанием, основной берёт', () => {
    expect(channelAllows(MAIN, { body: AD_BODY }).ok).toBe(true);
    expect(channelAllows(SECOND, { body: AD_BODY }).ok).toBe(false);
    expect(channelAllows(SECOND, { body: GOOD_DRAFT }).ok).toBe(true);
    const targets = publishTargets({ body: AD_BODY }, BOTH);
    expect(targets.allowed.map((c) => c.key)).toEqual(['main']);
    expect(targets.refused.map((r) => r.channel.key)).toEqual(['second']);
  });
});

describe('каналы из решения владельца', () => {
  const decision = (payload: unknown, id = 1) => ({
    id,
    kind: 'approve' as const,
    actor: 'owner' as const,
    actorId: OWNER,
    payload,
    createdAt: '2026-09-24T10:00:00.000Z',
  });

  it('берётся ПОСЛЕДНЕЕ подтверждение; без каналов — основной канал', () => {
    expect(approvedChannels([])).toEqual([]);
    expect(approvedChannels([decision(undefined)])).toEqual(['main']);
    expect(approvedChannels([decision({ channels: ['main'] }), decision({ channels: ['main', 'second'] }, 2)])).toEqual([
      'main',
      'second',
    ]);
  });

  it('повтор ключа не публикует дважды, мусор — основной канал', () => {
    expect(approvedChannels([decision({ channels: ['second', 'second'] })])).toEqual(['second']);
    expect(approvedChannels([decision({ channels: ['everywhere'] })])).toEqual(['main']);
  });
});

describe('кнопки под превью', () => {
  it('один канал — прежний вид с «Опубликовать»', () => {
    const controls = buildPreviewControls({ post: { body: GOOD_DRAFT }, postId: 'p1', stamp: 'abcdef12', channels: [MAIN], note: 'ready' });
    expect(controls.text).toBe(TEXTS.previewReady);
    expect(controls.keyboard.rows.map((row) => row.map((b) => b.text))).toEqual([
      [TEXTS.buttons.publish, TEXTS.buttons.edit],
      [TEXTS.buttons.otherAngle, TEXTS.buttons.drop],
    ]);
  });

  it('два канала — кнопка на канал, «в оба» и пометка про кнопку бота', () => {
    const controls = buildPreviewControls({ post: { body: GOOD_DRAFT }, postId: 'p1', stamp: 'abcdef12', channels: BOTH, note: 'ready' });
    expect(controls.keyboard.rows.map((row) => row.map((b) => b.text))).toEqual([
      ['В Оплатишку', 'В Aibromotion'],
      [TEXTS.buttons.publishBoth],
      [TEXTS.buttons.edit, TEXTS.buttons.otherAngle],
      [TEXTS.buttons.drop],
    ]);
    expect(controls.keyboard.rows[1]?.[0]?.data).toBe('p:pub.both:p1:abcdef12');
    expect(controls.text).toContain('Aibromotion: без кнопки «Оплатить подписку» под постом.');
  });

  it('текст с рекламой: кнопок Aibromotion нет, и сказано почему', () => {
    const controls = buildPreviewControls({ post: { body: AD_BODY }, postId: 'p1', stamp: 'abcdef12', channels: BOTH, note: 'ready' });
    const labels = controls.keyboard.rows.flat().map((b) => b.text);
    expect(labels).toContain(TEXTS.buttons.publish);
    expect(labels).not.toContain('В Aibromotion');
    expect(labels).not.toContain(TEXTS.buttons.publishBoth);
    expect(controls.text).toContain('Aibromotion: не публикую — канал без рекламы');
  });

  it('у черновика по расписанию действия с префиксом: кнопка называет пост сама', () => {
    const controls = buildPreviewControls({
      post: { body: GOOD_DRAFT },
      postId: 'p1',
      stamp: 'abcdef12',
      channels: BOTH,
      note: 'ready',
      prefix: 'a.',
      headline: 'Черновик на 10:00',
    });
    expect(controls.text.split('\n')[0]).toBe('Черновик на 10:00');
    expect(controls.keyboard.rows.flat().every((b) => b.data?.startsWith('p:a.') === true)).toBe(true);
  });
});

interface Sent {
  readonly chatId: string | number;
  readonly options: SendOptions;
}

function setup() {
  const store = openStore({ path: ':memory:' });
  const sent: Sent[] = [];
  let nextId = 700;
  const api: SendApi = {
    sendRichMessage(chatId, _rich, options) {
      sent.push({ chatId, options });
      return Promise.resolve({ message_id: (nextId += 1) });
    },
    sendPhoto(chatId, _photo, options) {
      sent.push({ chatId, options });
      return Promise.resolve({ message_id: (nextId += 1) });
    },
    sendMessage(chatId, _text, options) {
      sent.push({ chatId, options });
      return Promise.resolve({ message_id: (nextId += 1) });
    },
  };
  const runner = createRunner({
    store,
    handoff: () => Promise.resolve(),
    pipeline: {
      model: {
        json: () => Promise.resolve({ ok: false, reason: 'api_error', message: 'нет' }),
        markdown: () => Promise.resolve({ ok: false, reason: 'api_error', message: 'нет' }),
      },
      logger: silent(),
    },
    api,
    logger: silent(),
    ownerId: OWNER,
    ownerChatId: OWNER,
    channelId: MAIN.id,
    channels: BOTH,
  });
  return { store, runner, sent };
}

async function approvedPost(
  store: Store,
  runner: ReturnType<typeof setup>['runner'],
  channels: readonly string[],
  body = GOOD_DRAFT,
): Promise<string> {
  const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a' });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.patch(post.id, { body, sourceUrl: 'https://example.com/a' });
  await runner.preview(post.id);
  const sha = store.posts.get(post.id)?.textSha ?? '';
  store.posts.transition({
    id: post.id,
    from: ['previewed'],
    to: 'approved',
    decision: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: sha, payload: { channels } },
  });
  return post.id;
}

describe('публикация в два канала', () => {
  it('«в оба»: исходник в основной, копия во второй — у каждой свой номер и канал', async () => {
    const { store, runner, sent } = setup();
    const id = await approvedPost(store, runner, ['main', 'second']);
    const result = await runner.publish(id);
    expect(result).toMatchObject({ ok: true, summary: 'Опубликовал: Оплатишка, Aibromotion.' });

    const source = store.posts.get(id);
    expect(source).toMatchObject({ status: 'published', channel: 'main' });
    const [copy] = store.posts.channelCopies(id);
    expect(copy).toMatchObject({ status: 'published', channel: 'second', body: source?.body });
    expect(copy?.channelMessageId).not.toBe(source?.channelMessageId);

    // Кнопка бота — только в Оплатишке: во втором канале её нет вовсе.
    const toMain = sent.find((item) => item.chatId === MAIN.id);
    const toSecond = sent.find((item) => item.chatId === SECOND.id);
    expect(toMain?.options.keyboard?.rows.flat().map((b) => b.text)).toContain('Оплатить подписку');
    expect(toSecond?.options.keyboard?.rows.flat() ?? []).toEqual([]);
    store.close();
  });

  it('только второй канал: уходит туда и помечается его ключом', async () => {
    const { store, runner, sent } = setup();
    const id = await approvedPost(store, runner, ['second']);
    const result = await runner.publish(id);
    expect(result.ok).toBe(true);
    expect(store.posts.get(id)).toMatchObject({ status: 'published', channel: 'second' });
    expect(sent.filter((item) => item.chatId === MAIN.id)).toHaveLength(0);
    store.close();
  });

  it('реклама во второй канал не уходит, даже если кнопка была нажата', async () => {
    // Клавиатура могла быть старой, а колбэк — подделанным: правило проверяет сама публикация.
    const { store, runner, sent } = setup();
    const id = await approvedPost(store, runner, ['main', 'second'], AD_BODY);
    const result = await runner.publish(id);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Не ушло — Aibromotion: канал без рекламы');
    expect(sent.filter((item) => item.chatId === SECOND.id)).toHaveLength(0);
    // Неотправленная копия не висит «подтверждённой»: её хоронят.
    expect(store.posts.channelCopies(id).map((p) => p.status)).toEqual(['rejected']);
    store.close();
  });

  it('реклама только во второй канал — отказ целиком, основной не трогаем', async () => {
    const { store, runner, sent } = setup();
    const id = await approvedPost(store, runner, ['second'], AD_BODY);
    const result = await runner.publish(id);
    expect(result.ok).toBe(false);
    expect(store.posts.get(id)?.status).toBe('approved');
    expect(sent.filter((item) => item.chatId === MAIN.id || item.chatId === SECOND.id)).toHaveLength(0);
    store.close();
  });
});
