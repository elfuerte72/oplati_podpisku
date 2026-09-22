import { describe, expect, it } from 'vitest';

import { buildCallback } from '../dialog/callback.ts';
import type { DialogEvent, Keyboard, PipelineStep } from '../dialog/types.ts';
import { createLogger } from '../logger.ts';
import { openStore, textShaOf, type Store } from '../store/index.ts';
import { createEngine } from './engine.ts';
import type { BotPorts } from './ports.ts';
import { recoverPendingPublishes } from './recovery.ts';
import { createPublishTimers } from './timers.ts';

const OWNER = 379_336_096;
const NOW = '2026-09-22T10:00:00.000Z';

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

interface Recorded {
  readonly kind: string;
  readonly value?: unknown;
}

function fakePorts(steps: Partial<Record<PipelineStep, DialogEvent | undefined>> = {}): {
  ports: BotPorts;
  calls: Recorded[];
} {
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
      return Promise.resolve();
    },
    runStep(step: PipelineStep, args: Record<string, unknown>) {
      calls.push({ kind: 'run', value: { step, args } });
      return Promise.resolve(steps[step]);
    },
    schedulePublish(postId: string, at: string) {
      calls.push({ kind: 'schedule_publish', value: { postId, at } });
    },
    cancelPublish(postId: string) {
      calls.push({ kind: 'cancel_publish', value: postId });
    },
  };
  return { ports, calls };
}

function setup(steps: Partial<Record<PipelineStep, DialogEvent | undefined>> = {}) {
  const store = openStore({ path: ':memory:' });
  const { ports, calls } = fakePorts(steps);
  const engine = createEngine({
    store,
    ports,
    logger: silent(),
    ownerId: OWNER,
    undoSeconds: 60,
  });
  return { store, engine, calls, ports };
}

/** Пост, доведённый до превью: от него отсчитываются проверки публикации. */
function previewedPost(store: Store, body = '# Заголовок\n\nтело поста'): string {
  const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a' });
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

describe('состояние диалога', () => {
  it('переживает перезапуск: читается из базы, а не из памяти', async () => {
    const store = openStore({ path: ':memory:' });
    const first = createEngine({
      store,
      ports: fakePorts().ports,
      logger: silent(),
      ownerId: OWNER,
      undoSeconds: 60,
    });
    await first.handle({ kind: 'command', command: '/post', args: '', at: NOW });
    expect(first.current().name).toBe('post.await_input');

    // Новый экземпляр движка (как после редеплоя) видит то же состояние.
    const second = createEngine({
      store,
      ports: fakePorts().ports,
      logger: silent(),
      ownerId: OWNER,
      undoSeconds: 60,
    });
    expect(second.current().name).toBe('post.await_input');
    store.close();
  });

  it('незнакомое состояние в базе сбрасывается, а не ломает бота', () => {
    const store = openStore({ path: ':memory:' });
    store.flow.set(OWNER, { state: 'post.из_будущей_версии' });
    const engine = createEngine({
      store,
      ports: fakePorts().ports,
      logger: silent(),
      ownerId: OWNER,
      undoSeconds: 60,
    });
    expect(engine.current().name).toBe('idle');
    store.close();
  });
});

describe('гейт публикации', () => {
  it('клик «Опубликовать» пишет решение владельца с ПОЛНЫМ отпечатком', async () => {
    const { store, engine } = setup();
    const body = '# Заголовок\n\nтело поста';
    const postId = previewedPost(store, body);
    const full = textShaOf(body);
    const stamp = full.slice(0, 8);
    store.flow.set(OWNER, { state: 'post.previewed', postId, payload: { stamp } });

    await engine.handle({
      kind: 'callback',
      data: buildCallback('pub', postId, stamp),
      at: NOW,
      messageId: 10,
    });

    expect(store.posts.get(postId)?.status).toBe('approved');
    expect(store.posts.isApprovedForPublish(postId, OWNER)).toBe(true);
    const approve = store.posts.decisions(postId).find((d) => d.kind === 'approve');
    expect(approve?.textSha).toBe(full);
    expect(approve?.actorId).toBe(OWNER);
    store.close();
  });

  it('клик с чужим отпечатком не даёт права на публикацию', async () => {
    const { store, engine } = setup();
    const postId = previewedPost(store);
    store.flow.set(OWNER, { state: 'post.previewed', postId, payload: { stamp: 'deadbeef' } });

    await engine.handle({
      kind: 'callback',
      data: buildCallback('pub', postId, 'deadbeef'),
      at: NOW,
      messageId: 10,
    });

    expect(store.posts.get(postId)?.status).toBe('previewed');
    expect(store.posts.isApprovedForPublish(postId, OWNER)).toBe(false);
    store.close();
  });

  it('правка текста после подтверждения снимает право', async () => {
    const { store, engine } = setup();
    const body = '# Заголовок\n\nтело поста';
    const postId = previewedPost(store, body);
    const stamp = textShaOf(body).slice(0, 8);
    store.flow.set(OWNER, { state: 'post.previewed', postId, payload: { stamp } });
    await engine.handle({ kind: 'callback', data: buildCallback('pub', postId, stamp), at: NOW });
    expect(store.posts.isApprovedForPublish(postId, OWNER)).toBe(true);

    store.posts.patch(postId, { body: '# Другой заголовок\n\nдругое тело' });
    expect(store.posts.isApprovedForPublish(postId, OWNER)).toBe(false);
    store.close();
  });

  it('«Снять» переводит пост в rejected', async () => {
    const { store, engine } = setup();
    const postId = previewedPost(store);
    store.flow.set(OWNER, { state: 'post.previewed', postId, payload: { stamp: 'abcdef12' } });
    await engine.handle({ kind: 'callback', data: buildCallback('drop', postId, 'abcdef12'), at: NOW });
    expect(store.posts.get(postId)?.status).toBe('rejected');
    store.close();
  });
});

describe('окно отмены', () => {
  it('клик ставит таймер, отмена его снимает', async () => {
    const { store, engine, calls } = setup();
    const body = '# Заголовок\n\nтело поста';
    const postId = previewedPost(store, body);
    const stamp = textShaOf(body).slice(0, 8);
    store.flow.set(OWNER, { state: 'post.previewed', postId, payload: { stamp } });

    await engine.handle({ kind: 'callback', data: buildCallback('pub', postId, stamp), at: NOW });
    expect(calls.some((call) => call.kind === 'schedule_publish')).toBe(true);

    await engine.handle({ kind: 'callback', data: buildCallback('cancel', postId, stamp), at: NOW });
    expect(calls.some((call) => call.kind === 'cancel_publish')).toBe(true);
    expect(store.posts.get(postId)?.status).toBe('previewed');
    store.close();
  });

  it('срабатывание таймера зовёт шаг публикации', async () => {
    const { store, engine, calls } = setup();
    const postId = previewedPost(store);
    store.flow.set(OWNER, { state: 'post.publish_pending', postId, payload: { stamp: 'abcdef12' } });
    await engine.handle({ kind: 'timer_fired', postId, at: NOW });
    const run = calls.find((call) => call.kind === 'run');
    expect(run?.value).toMatchObject({ step: 'publish', args: { postId } });
    store.close();
  });
});

describe('перезапуск внутри окна отмены', () => {
  it('пост возвращается в превью и НЕ публикуется', () => {
    const store = openStore({ path: ':memory:' });
    const body = '# Заголовок\n\nтело поста';
    const postId = previewedPost(store, body);
    store.posts.transition({
      id: postId,
      from: ['previewed'],
      to: 'approved',
      decision: { kind: 'approve', actor: 'owner', actorId: OWNER, textSha: textShaOf(body) },
      patch: { publishAt: '2026-09-22T10:01:00.000Z' },
    });
    store.flow.set(OWNER, { state: 'post.publish_pending', postId, payload: { stamp: 'abcdef12' } });

    const result = recoverPendingPublishes(store, silent(), OWNER);

    expect(result.returned).toEqual([postId]);
    expect(store.posts.get(postId)?.status).toBe('previewed');
    expect(store.posts.get(postId)?.publishAt).toBeUndefined();
    expect(result.message).toContain('нажми «Опубликовать» ещё раз');
    // Состояние диалога тоже сброшено: кнопка «Отменить» больше не висит.
    expect(store.flow.get(OWNER)).toBeUndefined();
    store.close();
  });

  it('без зависших постов молчит', () => {
    const store = openStore({ path: ':memory:' });
    const result = recoverPendingPublishes(store, silent(), OWNER);
    expect(result.returned).toEqual([]);
    expect(result.message).toBeUndefined();
    store.close();
  });
});

describe('таймеры публикации', () => {
  it('живут в памяти: перезапуск их не воскрешает', () => {
    const fired: string[] = [];
    let queued: (() => void) | undefined;
    const timers = createPublishTimers({
      logger: silent(),
      now: () => new Date(NOW),
      setTimer: (fn) => {
        queued = fn;
        return 1;
      },
      clearTimer: () => {
        queued = undefined;
      },
    });
    timers.schedule('p1', '2026-09-22T10:01:00.000Z', (id) => fired.push(id));
    expect(timers.size()).toBe(1);
    timers.cancel('p1');
    expect(timers.size()).toBe(0);
    expect(queued).toBeUndefined();
    expect(fired).toEqual([]);
  });

  it('повторная постановка заменяет прежний таймер', () => {
    const timers = createPublishTimers({
      logger: silent(),
      now: () => new Date(NOW),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    timers.schedule('p1', '2026-09-22T10:01:00.000Z', () => undefined);
    timers.schedule('p1', '2026-09-22T10:02:00.000Z', () => undefined);
    expect(timers.size()).toBe(1);
    timers.stopAll();
    expect(timers.size()).toBe(0);
  });
});

describe('цепочка событий', () => {
  it('исход шага сразу обрабатывается следующим переходом', async () => {
    const { store, engine, calls } = setup({
      source: {
        kind: 'pipeline_done',
        at: NOW,
        outcome: { kind: 'article', postId: 'post-1', title: 'Заголовок' },
      },
      plan: undefined,
    });
    await engine.handle({ kind: 'command', command: '/post', args: 'https://example.com/a', at: NOW });
    const steps = calls.filter((call) => call.kind === 'run').map((call) => (call.value as { step: string }).step);
    // Источник прочитан — автомат сразу попросил досье и план.
    expect(steps).toEqual(['source', 'plan']);
    store.close();
  });
});

describe('отметка о публикации в Threads', () => {
  /** Пост площадки, отданный владельцу: следующий шаг — его слово «выложил». */
  function handedPost(store: Store, body = 'Пост для площадки'): string {
    const post = store.posts.create({ platform: 'threads', rubric: 'news' });
    store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
    store.posts.transition({
      id: post.id,
      from: ['reviewed'],
      to: 'handed',
      decision: { kind: 'preview', actor: 'code' },
      patch: { body },
    });
    return post.id;
  }

  it('«Выложил» двигает статус в posted и пишет решение владельца', async () => {
    const { store, engine } = setup();
    const postId = handedPost(store);
    const stamp = (store.posts.get(postId)?.textSha ?? '').slice(0, 8);
    store.flow.set(OWNER, { state: 'threads.previewed', postId, payload: { stamp } });

    await engine.handle({ kind: 'callback', data: buildCallback('posted', postId, stamp), at: NOW });

    expect(store.posts.get(postId)?.status).toBe('posted');
    const decisions = store.posts.decisions(postId);
    expect(decisions.some((decision) => decision.kind === 'threads_posted')).toBe(true);
  });

  it('пост в канал бот не отправляет: публиковал человек', async () => {
    const { store, engine, calls } = setup();
    const postId = handedPost(store);
    const stamp = (store.posts.get(postId)?.textSha ?? '').slice(0, 8);
    store.flow.set(OWNER, { state: 'threads.previewed', postId, payload: { stamp } });

    await engine.handle({ kind: 'callback', data: buildCallback('posted', postId, stamp), at: NOW });

    expect(calls.filter((call) => call.kind === 'run')).toHaveLength(0);
  });
});

describe('журнальные решения', () => {
  it('выбор рубрики на ЧЕРНОВИКЕ не роняет обработку: эффекты после него доходят', async () => {
    const { store, engine, calls } = setup({ produce: undefined });
    const post = store.posts.create({ platform: 'telegram' });
    const stamp = 'questio1';
    store.flow.set(OWNER, {
      state: 'post.await_rubric',
      postId: post.id,
      payload: { stamp, angles: [{ title: 'Угол', idea: 'идея' }] },
    });

    await engine.handle({ kind: 'callback', data: buildCallback('rub.news', post.id, stamp), at: NOW });

    // Статус не двигается: рубрика — запись в журнале, а не шаг машины.
    expect(store.posts.get(post.id)?.status).toBe('draft');
    expect(store.posts.decisions(post.id).some((decision) => decision.kind === 'rubric')).toBe(true);
    // Вопрос про угол обязан дойти: раньше исключение гасило всё после решения.
    const sends = calls.filter((call) => call.kind === 'send');
    expect(sends.length).toBeGreaterThan(0);
  });
});

describe('порядок эффектов', () => {
  it('«Собираю» приходит ДО результата шага, а не после него', async () => {
    const { store, engine, calls } = setup({
      source: {
        kind: 'pipeline_done',
        outcome: { kind: 'article', postId: 'p-1', title: 'Заголовок' },
        at: NOW,
      },
    });
    void store;

    await engine.handle({ kind: 'command', command: '/post', args: 'https://example.com/a', at: NOW });

    const order = calls.map((call) => call.kind);
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('run'));
  });
});

describe('счастливый путь целиком', () => {
  it('от /post до подтверждения публикации: каждый шаг получает кнопки', async () => {
    const store = openStore({ path: ':memory:' });
    const post = store.posts.create({ platform: 'telegram', rubric: 'news', layout: 'a' });
    store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    store.posts.transition({ id: post.id, from: ['linted'], to: 'reviewed', decision: { kind: 'judge', actor: 'model' } });
    store.posts.patch(post.id, { body: '# Заголовок\n\nтело поста' });
    const textSha = store.posts.get(post.id)?.textSha ?? '';

    const { ports, calls } = fakePorts({
      source: { kind: 'pipeline_done', outcome: { kind: 'article', postId: post.id, title: 'Заголовок' }, at: NOW },
      plan: {
        kind: 'pipeline_done',
        outcome: {
          kind: 'plan',
          postId: post.id,
          rubric: 'news',
          angles: [{ title: 'Угол', idea: 'идея' }],
        },
        at: NOW,
      },
      produce: {
        kind: 'pipeline_done',
        outcome: { kind: 'post', postId: post.id, textSha, verdict: 'pass' },
        at: NOW,
      },
    });
    // Показ превью — ФАКТ, от которого отсчитывается право на публикацию:
    // в живом контуре его фиксирует исполнитель, здесь — двойник.
    const previewing: BotPorts = {
      ...ports,
      preview(postId: string) {
        calls.push({ kind: 'preview', value: postId });
        store.posts.transition({
          id: postId,
          from: ['reviewed', 'previewed'],
          to: 'previewed',
          decision: { kind: 'preview', actor: 'code' },
        });
        return Promise.resolve();
      },
    };
    const engine = createEngine({ store, ports: previewing, logger: silent(), ownerId: OWNER, undoSeconds: 60 });

    await engine.handle({ kind: 'command', command: '/post', args: 'https://example.com/a', at: NOW });
    expect(engine.current().name).toBe('post.await_rubric');

    const rubricKeyboard = lastKeyboard(calls);
    await engine.handle({ kind: 'callback', data: dataOf(rubricKeyboard, 0), at: NOW, messageId: 1 });
    expect(engine.current().name).toBe('post.await_angle');

    const angleKeyboard = lastKeyboard(calls);
    await engine.handle({ kind: 'callback', data: dataOf(angleKeyboard, 0), at: NOW, messageId: 2 });
    expect(engine.current().name).toBe('post.previewed');
    expect(calls.some((call) => call.kind === 'preview')).toBe(true);

    // Под превью обязаны быть кнопки: иначе опубликовать нечем.
    const previewButtons = lastKeyboard(calls);
    await engine.handle({ kind: 'callback', data: dataOf(previewButtons, 0), at: NOW, messageId: 3 });

    expect(store.posts.get(post.id)?.status).toBe('approved');
    expect(store.posts.isApprovedForPublish(post.id, OWNER)).toBe(true);
    expect(calls.some((call) => call.kind === 'schedule_publish')).toBe(true);
  });
});

/** Клавиатура последнего сообщения владельцу. */
function lastKeyboard(calls: readonly Recorded[]): Keyboard {
  const sends = calls.filter((call) => call.kind === 'send');
  for (let index = sends.length - 1; index >= 0; index -= 1) {
    const value = sends[index]?.value as { keyboard?: Keyboard } | undefined;
    if (value?.keyboard !== undefined) return value.keyboard;
  }
  throw new Error('владельцу не пришло ни одной кнопки');
}

function dataOf(keyboard: Keyboard, index: number): string {
  const button = keyboard.rows.flat()[index];
  if (button?.data === undefined) throw new Error('кнопка без действия');
  return button.data;
}
