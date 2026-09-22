import { describe, expect, it } from 'vitest';

import { buildCallback } from '../dialog/callback.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { DialogEvent, Keyboard, PipelineStep } from '../dialog/types.ts';
import { createLogger } from '../logger.ts';
import { openStore, type Store } from '../store/index.ts';
import { createEngine } from './engine.ts';
import { ideaItems, ideasEmptyText } from './ideas-view.ts';
import type { BotPorts } from './ports.ts';

const OWNER = 379_336_096;
const NOW = '2026-09-22T10:00:00.000Z';

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function ports(): { ports: BotPorts; calls: { kind: string; value?: unknown }[] } {
  const calls: { kind: string; value?: unknown }[] = [];
  return {
    calls,
    ports: {
      send(text: string, keyboard?: Keyboard) {
        calls.push({ kind: 'send', value: { text, keyboard } });
        return Promise.resolve(1);
      },
      editKeyboard() {
        return Promise.resolve();
      },
      answerCallback(text?: string) {
        calls.push({ kind: 'answer_callback', value: text });
        return Promise.resolve();
      },
      preview() {
        return Promise.resolve({ ok: true as const });
      },
      runStep(step: PipelineStep, args: Record<string, unknown>) {
        calls.push({ kind: 'run', value: { step, args } });
        return Promise.resolve(undefined as DialogEvent | undefined);
      },
      schedulePublish() {},
      cancelPublish() {},
    },
  };
}

function seed(store: Store): { hot: string; cold: string; covered: string } {
  const hot = store.items.upsertByUrl({
    sourceKind: 'rss',
    sourceRef: 'https://blog.example.com/feed',
    url: 'https://blog.example.com/hot',
    title: 'Память Gemini бесплатным',
  });
  store.items.setRank(hot.id, {
    url: hot.url,
    rubric: 'news',
    relevance: 5,
    reader_action: true,
    already_covered: false,
    why: 'можно включить сегодня',
  });

  const cold = store.items.upsertByUrl({
    sourceKind: 'hn',
    url: 'https://blog.example.com/cold',
    title: 'Новость для исследователей',
  });
  store.items.setRank(cold.id, {
    url: cold.url,
    relevance: 2,
    reader_action: false,
    already_covered: false,
  });

  const covered = store.items.upsertByUrl({
    sourceKind: 'rss',
    url: 'https://blog.example.com/covered',
    title: 'Про это уже писали',
  });
  store.items.setRank(covered.id, {
    url: covered.url,
    relevance: 4,
    reader_action: true,
    already_covered: true,
  });

  return { hot: hot.id, cold: cold.id, covered: covered.id };
}

describe('дайджест идей', () => {
  it('сортирует по оценке и прячет уже освещённое', () => {
    const store = openStore({ path: ':memory:' });
    seed(store);
    const lines = ideaItems(store);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.item.title).toBe('Память Gemini бесплатным');
    expect(lines.map((line) => line.item.title)).not.toContain('Про это уже писали');
    // В строке есть источник, рубрика и адрес — но не текст чужого поста.
    expect(lines[0]?.line).toContain('https://blog.example.com/hot');
    expect(lines[0]?.line).toContain('Что нового в ИИ');
    store.close();
  });

  it('решённые темы в дайджест не возвращаются', () => {
    const store = openStore({ path: ':memory:' });
    const ids = seed(store);
    store.items.markVerdict(ids.hot, 'skipped');
    expect(ideaItems(store).map((line) => line.item.id)).not.toContain(ids.hot);
    store.close();
  });

  it('пустой дайджест говорит об этом словами', () => {
    expect(ideasEmptyText()).toContain('Новых тем нет');
  });
});

describe('кнопки дайджеста', () => {
  function setup() {
    const store = openStore({ path: ':memory:' });
    const ids = seed(store);
    const { ports: p, calls } = ports();
    const engine = createEngine({ store, ports: p, logger: silent(), ownerId: OWNER, undoSeconds: 60 });
    return { store, engine, calls, ids };
  }

  it('«Написать» запускает конвейер с готовым источником, без вопроса владельцу', async () => {
    const { store, engine, calls, ids } = setup();
    await engine.handle({ kind: 'callback', data: buildCallback('i.write', ids.hot, 'idea'), at: NOW });

    expect(engine.current().name).toBe('post.generating');
    expect(calls.find((call) => call.kind === 'run')).toMatchObject({
      value: { step: 'source', args: { itemId: ids.hot } },
    });
    // ⚠️ Отметку «написали» ставит сам шаг источника: двойник шагов его не
    // исполняет, поэтому тема остаётся нерешённой — и это правильно, статья
    // ещё не открылась.
    expect(store.items.findById(ids.hot)?.verdict).toBeUndefined();
    store.close();
  });

  it('«Пропустить» помечает тему и ничего не запускает', async () => {
    const { store, engine, calls, ids } = setup();
    await engine.handle({ kind: 'callback', data: buildCallback('i.skip', ids.cold, 'idea'), at: NOW });

    expect(store.items.findById(ids.cold)?.verdict).toBe('skipped');
    expect(calls.filter((call) => call.kind === 'run')).toHaveLength(0);
    expect(engine.current().name).toBe('idle');
    store.close();
  });

  it('«Не по теме» попадает в исключения следующего ранжирования', async () => {
    const { store, engine, ids } = setup();
    await engine.handle({ kind: 'callback', data: buildCallback('i.off', ids.cold, 'idea'), at: NOW });

    expect(store.items.findById(ids.cold)?.verdict).toBe('offtopic');
    expect(store.offtopic.list()).toContain('Новость для исследователей');
    store.close();
  });

  it('кнопка идеи не перебивает начатый пост', async () => {
    const { store, engine, calls, ids } = setup();
    store.flow.set(OWNER, { state: 'post.await_rubric', postId: 'p1', payload: { stamp: 's' } });

    await engine.handle({ kind: 'callback', data: buildCallback('i.write', ids.hot, 'idea'), at: NOW });

    expect(engine.current().name).toBe('post.await_rubric');
    expect(store.items.findById(ids.hot)?.verdict).toBeUndefined();
    expect(calls.find((call) => call.kind === 'answer_callback')?.value).toBe(TEXTS.notNow);
    store.close();
  });
});
