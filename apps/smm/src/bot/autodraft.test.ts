import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChannelTarget } from '../config/env.ts';
import { smmConfig, type ModelRole } from '../config/smm.config.ts';
import type { Keyboard } from '../dialog/types.ts';
import type { Model, ModelResult } from '../llm/model.ts';
import { createLogger } from '../logger.ts';
import { DOSSIER, GOOD_DRAFT, judgePass, PLAN_ANSWER } from '../pipeline/fixtures.ts';
import type { SendApi } from '../render/send.ts';
import { ARTICLE_HTML } from '../sources/fixtures.ts';
import type { Fetcher } from '../sources/index.ts';
import { openStore, type Store } from '../store/index.ts';
import {
  createAutodraftScheduler,
  dueSlot,
  pickAngle,
  runAutodraft,
  SETTINGS_AUTODRAFT_ENABLED,
  AutodraftEnabled,
  slotKey,
  type AutodraftDeps,
} from './autodraft.ts';
import { createRunner, type Runner } from './runner.ts';

const OWNER = 379_336_096;
const CHANNELS: readonly ChannelTarget[] = [
  { key: 'main', id: '-1004257122135', username: 'ooplatishka', title: 'Оплатишка', label: 'В Оплатишку' },
  { key: 'second', id: '-1003314281166', username: 'aibromotion', title: 'Aibromotion', label: 'В Aibromotion' },
];

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

/** Момент по Москве: `msk(10, 5)` — 10:05 МСК 24.09.2026. */
function msk(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 24, hour - 3, minute));
}

describe('какой слот пора отработать', () => {
  const none = (): boolean => false;

  it('до первого слота — ничего, в слот — он', () => {
    expect(dueSlot('telegram', msk(9, 59), none)).toEqual({ kind: 'none' });
    expect(dueSlot('telegram', msk(10, 0), none)).toMatchObject({ kind: 'run', hour: 10 });
    expect(dueSlot('threads', msk(12, 30), none)).toMatchObject({ kind: 'run', hour: 12 });
  });

  it('отработанный слот второй раз не срабатывает', () => {
    const done = new Set([slotKey('telegram', msk(10), 10)]);
    expect(dueSlot('telegram', msk(10, 40), (key) => done.has(key))).toEqual({ kind: 'none' });
  });

  it('после простоя берётся ПОСЛЕДНИЙ слот, а не все пропущенные разом', () => {
    // 14:30, слоты 10 и 14 не отработаны: черновик один, за 14:00.
    expect(dueSlot('telegram', msk(14, 30), none)).toMatchObject({ kind: 'run', hour: 14 });
  });

  it('опоздавший дольше двух часов слот пропускается, а не присылает утро вечером', () => {
    expect(dueSlot('telegram', msk(12, 10), none)).toMatchObject({ kind: 'late', hour: 10 });
    expect(dueSlot('telegram', msk(11, 59), none)).toMatchObject({ kind: 'run', hour: 10 });
  });

  it('слоты живут в окне опроса источников: к слоту идеи уже свежие', () => {
    const { fromHour, toHour } = smmConfig.sources.pollWindowMsk;
    for (const slot of [...smmConfig.autodraft.slotsMsk.telegram, ...smmConfig.autodraft.slotsMsk.threads]) {
      expect(slot).toBeGreaterThanOrEqual(fromHour);
      expect(slot).toBeLessThan(toHour);
    }
  });
});

describe('угол черновика', () => {
  it('берётся угол с действием для читателя, иначе первый', () => {
    expect(pickAngle([{ title: 'а', idea: '' }, { title: 'б', idea: '', readerAction: true }])?.title).toBe('б');
    expect(pickAngle([{ title: 'а', idea: '' }])?.title).toBe('а');
    expect(pickAngle([])).toBeUndefined();
  });
});

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
    json: (role) => Promise.resolve(next(role)),
    markdown: (role) => Promise.resolve(next(role) as ModelResult<string>),
  };
}

const pages: Fetcher = (url) =>
  url.endsWith('.jpg')
    ? Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    : Promise.resolve(new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));

const api: SendApi = {
  sendRichMessage: () => Promise.resolve({ message_id: 1 }),
  sendPhoto: () => Promise.resolve({ message_id: 2 }),
  sendMessage: () => Promise.resolve({ message_id: 3 }),
};

interface Sent {
  readonly text: string;
  readonly keyboard?: Keyboard;
}

function setup(answers: Partial<Record<ModelRole, unknown[]>> = {}) {
  const store = openStore({ path: ':memory:', now: () => msk(10, 5) });
  const runner = createRunner({
    store,
    handoff: () => Promise.resolve(),
    pipeline: { model: fakeModel(answers), logger: silent() },
    api,
    logger: silent(),
    ownerId: OWNER,
    ownerChatId: OWNER,
    channelId: CHANNELS[0]?.id ?? '',
    channels: CHANNELS,
    mediaDir: mkdtempSync(join(tmpdir(), 'smm-autodraft-')),
    resolve: { fetcher: pages, resolver: () => Promise.resolve(['93.184.216.34']) },
    now: () => msk(10, 5),
  });
  const sent: Sent[] = [];
  const deps: AutodraftDeps = {
    store,
    runner,
    send: (text, keyboard) => {
      sent.push({ text, ...(keyboard === undefined ? {} : { keyboard }) });
      return Promise.resolve();
    },
    logger: silent(),
    channels: CHANNELS,
    now: () => msk(10, 5),
  };
  return { store, runner, deps, sent };
}

function idea(store: Store, relevance: number, url = 'https://example.com/post'): string {
  const item = store.items.upsertByUrl({ sourceKind: 'rss', url, title: 'Память Gemini' });
  store.items.setRank(item.id, { relevance, rubric: 'news', reader_action: true, already_covered: false });
  return item.id;
}

const FULL = { dossier: [DOSSIER], plan: [PLAN_ANSWER], write: [GOOD_DRAFT], judge: [judgePass()] };

describe('черновик по расписанию', () => {
  it('пишет пост из лучшей идеи и присылает превью с кнопками двух каналов', async () => {
    const { store, deps, sent } = setup(FULL);
    const itemId = idea(store, 4);

    const result = await runAutodraft('telegram', '10:00', deps);
    expect(result).toMatchObject({ kind: 'sent', itemId, verdict: 'pass' });
    if (result.kind !== 'sent') return;

    const post = store.posts.get(result.postId);
    // Пост помнит, откуда он: черновик по расписанию и его идея.
    expect(post).toMatchObject({ origin: 'auto', itemId, status: 'previewed', platform: 'telegram' });
    // Угол — с действием для читателя, а не просто первый.
    expect(post?.angle).toBe('Проверь память в своём аккаунте');
    // Без рекламы: один текст обязан годиться и для канала без рекламы.
    expect(post?.cta).toBe('none');
    expect(Array.isArray(post?.angles)).toBe(true);
    // Идея занята и из /ideas ушла.
    expect(store.items.findById(itemId)?.autoAt).toBeDefined();

    const controls = sent.at(-1);
    expect(controls?.text.split('\n')[0]).toBe('Черновик на 10:00 по расписанию. Так пост уйдёт в канал.');
    const labels = controls?.keyboard?.rows.flat().map((button) => button.text) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['В Оплатишку', 'В Aibromotion', 'В оба канала', 'Правки']));
    // Кнопки черновика называют пост сами: диалог владельца не тронут.
    expect(controls?.keyboard?.rows.flat().every((button) => button.data?.startsWith('p:a.') === true)).toBe(true);
    expect(store.flow.get(OWNER)).toBeUndefined();
  });

  it('три неразобранных черновика — слот пропускается, идея не тратится', async () => {
    const { store, deps } = setup(FULL);
    const itemId = idea(store, 5);
    for (let index = 0; index < smmConfig.autodraft.maxPending; index += 1) {
      const post = store.posts.create({ platform: 'telegram', origin: 'auto' });
      store.posts.transition({ id: post.id, from: ['draft'], to: 'linted', decision: { kind: 'lint', actor: 'code' } });
    }
    expect(await runAutodraft('telegram', '14:00', deps)).toEqual({ kind: 'skipped', reason: 'too_many_pending' });
    expect(store.items.findById(itemId)?.autoAt).toBeUndefined();
  });

  it('слабая идея не пишется: лучше пропустить слот, чем прислать проходное', async () => {
    const { store, deps } = setup(FULL);
    idea(store, smmConfig.autodraft.minRelevance - 1);
    expect(await runAutodraft('telegram', '10:00', deps)).toEqual({ kind: 'skipped', reason: 'no_idea' });
  });

  it('сбой на шаге — исход с причиной, а идея остаётся занятой и не берётся снова', async () => {
    const { store, deps } = setup({});
    const itemId = idea(store, 4);
    const result = await runAutodraft('telegram', '10:00', deps);
    expect(result).toMatchObject({ kind: 'failed', step: 'plan' });
    expect(store.items.findById(itemId)?.autoAt).toBeDefined();
    expect(await runAutodraft('telegram', '14:00', deps)).toEqual({ kind: 'skipped', reason: 'no_idea' });
  });
});

describe('черновик для Threads', () => {
  it('подпись приходит ДО поста, а превью — с кнопками черновика', async () => {
    const store = openStore({ path: ':memory:' });
    const itemId = idea(store, 4);
    const calls: string[] = [];
    const runner: Pick<Runner, 'runStep' | 'preview'> = {
      runStep(step, args) {
        calls.push(step);
        const at = msk(12).toISOString();
        if (step === 'source') {
          const post = store.posts.create({ platform: 'threads', origin: 'auto', itemId: String(args.itemId) });
          return Promise.resolve({ kind: 'pipeline_done', at, outcome: { kind: 'article', postId: post.id, title: 'т' } });
        }
        if (step === 'plan') {
          return Promise.resolve({
            kind: 'pipeline_done',
            at,
            outcome: { kind: 'plan', postId: String(args.postId), rubric: 'news', angles: [{ title: 'угол', idea: 'суть' }] },
          });
        }
        return Promise.resolve({
          kind: 'pipeline_done',
          at,
          outcome: { kind: 'post', postId: String(args.postId), textSha: 'abcdef1234', verdict: 'pass', platform: 'threads' },
        });
      },
      preview(_postId, options) {
        calls.push(`preview:${options?.prefix ?? ''}`);
        return Promise.resolve({ ok: true });
      },
    };
    const sent: string[] = [];
    const result = await runAutodraft('threads', '12:00', {
      store,
      runner,
      send: (text) => {
        sent.push(text);
        calls.push('send');
        return Promise.resolve();
      },
      logger: silent(),
      channels: CHANNELS,
    });
    expect(result).toMatchObject({ kind: 'sent', itemId });
    expect(calls).toEqual(['source', 'plan', 'produce', 'send', 'preview:a.']);
    expect(sent[0]).toBe('Черновик для Threads на 12:00 по расписанию.');
  });
});

describe('планировщик', () => {
  it('слот занимается до прогона и второй раз не срабатывает; сбой уходит владельцу', async () => {
    const { store, deps, sent } = setup({});
    idea(store, 4);
    const scheduler = createAutodraftScheduler({ ...deps, now: () => msk(10, 5) });
    await scheduler.tick();
    expect(sent.some((message) => message.text.startsWith('Черновик на 10:00 не собрался'))).toBe(true);
    const keys = store.settings.keys().filter((key) => key.startsWith('autodraft.slot.telegram'));
    expect(keys).toEqual([slotKey('telegram', msk(10, 5), 10)]);

    const before = sent.length;
    await scheduler.tick();
    expect(sent.length).toBe(before);
  });

  it('выключенный — не пишет ничего', async () => {
    const { store, deps, sent } = setup(FULL);
    idea(store, 4);
    store.settings.set(SETTINGS_AUTODRAFT_ENABLED, AutodraftEnabled, false);
    await createAutodraftScheduler({ ...deps, now: () => msk(10, 5) }).tick();
    expect(sent).toEqual([]);
    expect(store.settings.keys().some((key) => key.startsWith('autodraft.slot.'))).toBe(false);
  });
});
