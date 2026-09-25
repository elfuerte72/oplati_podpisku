import { describe, expect, it } from 'vitest';

import type { ChannelTarget } from '../config/env.ts';
import { buildCallback } from '../dialog/callback.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { Keyboard } from '../dialog/types.ts';
import { createLogger } from '../logger.ts';
import { openStore, type Store } from '../store/index.ts';
import { createEngine } from './engine.ts';
import type { BotPorts } from './ports.ts';

const OWNER = 379_336_096;
const NOW = '2026-09-24T10:00:00.000Z';
const CHANNELS: readonly ChannelTarget[] = [
  { key: 'main', id: '-1004257122135', username: 'ooplatishka', title: 'Оплатишка', label: 'В Оплатишку' },
  { key: 'second', id: '-1003314281166', username: 'aibromotion', title: 'Aibromotion', label: 'В Aibromotion' },
];

interface Recorded {
  readonly kind: string;
  readonly value?: unknown;
}

function setup() {
  const store = openStore({ path: ':memory:', now: () => new Date(NOW) });
  const calls: Recorded[] = [];
  const ports: BotPorts = {
    send(text: string, keyboard?: Keyboard) {
      calls.push({ kind: 'send', value: { text, keyboard } });
      return Promise.resolve(1);
    },
    editKeyboard(messageId: number) {
      calls.push({ kind: 'edit_keyboard', value: messageId });
      return Promise.resolve();
    },
    answerCallback(text?: string) {
      calls.push({ kind: 'answer_callback', value: text });
      return Promise.resolve();
    },
    preview(postId: string) {
      calls.push({ kind: 'preview', value: postId });
      return Promise.resolve({ ok: true as const });
    },
    runStep() {
      return Promise.resolve(undefined);
    },
    schedulePublish(postId: string, at: string) {
      calls.push({ kind: 'schedule_publish', value: { postId, at } });
    },
    cancelPublish(postId: string) {
      calls.push({ kind: 'cancel_publish', value: postId });
    },
  };
  const engine = createEngine({
    store,
    ports,
    logger: createLogger({ level: 'fatal', stream: { write() {} } }),
    ownerId: OWNER,
    undoSeconds: 60,
    channels: CHANNELS,
    now: () => new Date(NOW),
  });
  return { store, engine, calls };
}

/** Черновик по расписанию, уже показанный владельцу: вне диалога, со своими углами. */
function autoDraft(store: Store, body = '# Заголовок\n\nтело поста'): { id: string; stamp: string } {
  const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a', origin: 'auto' });
  store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
  store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
  store.posts.transition({
    id: post.id,
    from: ['reviewed'],
    to: 'previewed',
    decision: { kind: 'preview', actor: 'code' },
    patch: {
      body,
      angle: 'Дешевле на 40%',
      angles: [
        { title: 'Дешевле на 40%', idea: 'что это значит' },
        { title: 'Длинные задачи', idea: 'как отдать проект' },
      ],
    },
  });
  return { id: post.id, stamp: (store.posts.get(post.id)?.textSha ?? '').slice(0, 8) };
}

describe('черновик по расписанию в диалоге', () => {
  it('«В оба канала» из покоя: пост усыновлён, решение с двумя каналами, окно отмены', async () => {
    const { store, engine, calls } = setup();
    const { id, stamp } = autoDraft(store);
    await engine.handle({ kind: 'callback', data: buildCallback('a.pub.both', id, stamp), at: NOW, messageId: 5 });

    expect(engine.current()).toMatchObject({ name: 'post.publish_pending', postId: id });
    expect(store.posts.get(id)?.status).toBe('approved');
    const approve = store.posts.decisions(id).find((decision) => decision.kind === 'approve');
    expect(approve).toMatchObject({ actor: 'owner', actorId: OWNER, payload: { channels: ['main', 'second'] } });
    expect(calls.some((call) => call.kind === 'schedule_publish')).toBe(true);
  });

  it('«Другой угол» у черновика берёт углы из самого поста', async () => {
    const { store, engine, calls } = setup();
    const { id, stamp } = autoDraft(store);
    await engine.handle({ kind: 'callback', data: buildCallback('a.angle', id, stamp), at: NOW });
    const state = engine.current();
    expect(state.name).toBe('post.await_angle');
    const asked = calls.filter((call) => call.kind === 'send').map((call) => (call.value as { text: string }).text);
    expect(asked.some((text) => text.includes('Длинные задачи — как отдать проект'))).toBe(true);
  });

  it('переписанный или уже решённый черновик — кнопка старая, диалог не трогается', async () => {
    const { store, engine, calls } = setup();
    const { id, stamp } = autoDraft(store);
    store.posts.transition({
      id,
      from: ['previewed'],
      to: 'rejected',
      decision: { kind: 'reject', actor: 'owner', actorId: OWNER },
    });
    await engine.handle({ kind: 'callback', data: buildCallback('a.pub', id, stamp), at: NOW, messageId: 9 });
    expect(engine.current().name).toBe('idle');
    expect(calls).toContainEqual({ kind: 'answer_callback', value: TEXTS.stale });
    expect(calls).toContainEqual({ kind: 'edit_keyboard', value: 9 });
  });

  it('кнопки превью в диалоге приходят с каналами', async () => {
    const { store, engine, calls } = setup();
    const { id, stamp } = autoDraft(store);
    await engine.handle({ kind: 'callback', data: buildCallback('a.edit', id, stamp), at: NOW });
    await engine.handle({ kind: 'callback', data: buildCallback('back', id, stamp), at: NOW });
    const last = calls.filter((call) => call.kind === 'send').at(-1)?.value as { keyboard?: Keyboard } | undefined;
    const labels = last?.keyboard?.rows.flat().map((button) => button.text) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['В Оплатишку', 'В Aibromotion', TEXTS.buttons.publishBoth]));
  });
});
