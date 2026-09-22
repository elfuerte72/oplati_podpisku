import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadEnv, type SmmEnv } from '../config/env.ts';
import { createLogger } from '../logger.ts';
import { openStore, type Store } from '../store/index.ts';
import { createModel, extractJson, type MessagesClient } from './model.ts';

interface Recorded {
  readonly params: Anthropic.MessageCreateParamsNonStreaming;
  readonly options?: { timeout?: number };
}

/** Фейковый транспорт: ответы задаёт тест, сеть не участвует. */
function fakeClient(
  replies: (
    | { text: string; stopReason?: Anthropic.Message['stop_reason']; usage?: Partial<Anthropic.Usage> }
    | { throws: Error }
  )[],
): { client: MessagesClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const client: MessagesClient = {
    messages: {
      create(params, options) {
        calls.push({ params, options });
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        if (reply === undefined) throw new Error('фейк не знает, что ответить');
        if ('throws' in reply) return Promise.reject(reply.throws);
        const message: Anthropic.Message = {
          id: `msg_${index}`,
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'text', text: reply.text, citations: null }],
          stop_reason: reply.stopReason ?? 'end_turn',
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
            ...reply.usage,
          } as Anthropic.Usage,
        };
        return Promise.resolve(message);
      },
    },
  };
  return { client, calls };
}

function silentLogger() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function testEnv(overrides: Record<string, string> = {}): SmmEnv {
  return loadEnv({
    SMM_BOT_TOKEN: '123:abc',
    SMM_OWNER_ID: '1',
    SMM_CHANNEL_ID: '-100123',
    SMM_CHANNEL_USERNAME: 'ooplatishka',
    SMM_MODEL_API_KEY: 'sk-test',
    ...overrides,
  });
}

function setup(
  replies: Parameters<typeof fakeClient>[0],
  options: { env?: SmmEnv; now?: () => Date } = {},
): { model: ReturnType<typeof createModel>; calls: Recorded[]; store: Store } {
  const { client, calls } = fakeClient(replies);
  const store = openStore({ path: ':memory:', now: options.now });
  const model = createModel({
    client,
    env: options.env ?? testEnv(),
    usage: store.usage,
    logger: silentLogger(),
    promptSet: {
      dossier: 'промпт досье',
      plan: 'промпт плана',
      write: 'промпт автора',
      revise: 'промпт правок',
      judge: 'промпт судьи',
      rank: 'промпт ранжирования',
      threads: 'промпт threads',
    },
    now: options.now,
  });
  return { model, calls, store };
}

const Simple = z.object({ a: z.number(), b: z.string() });

describe('форма запроса', () => {
  it('без инструментов, без кэша, thinking выключен, system строкой', async () => {
    // Оговорки провайдера: с включённым thinking игнорируется temperature,
    // форма system массивом у него не описана, cache_control игнорируется.
    const { model, calls } = setup([{ text: '{"a":1,"b":"да"}' }]);
    await model.json('plan', 'вход', Simple);
    const [call] = calls;
    expect(call?.params.tools).toBeUndefined();
    expect(call?.params.thinking).toEqual({ type: 'disabled' });
    expect(typeof call?.params.system).toBe('string');
    expect(call?.params.metadata).toBeUndefined();
    expect(JSON.stringify(call?.params)).not.toContain('cache_control');
    expect(call?.params.stream).toBeUndefined();
    expect(call?.params.messages).toHaveLength(1);
  });

  it('температура, потолок токенов и срок берутся из роли', async () => {
    const { model, calls } = setup([{ text: '{"a":1,"b":"да"}' }]);
    await model.json('judge', 'вход', Simple);
    expect(calls[0]?.params.temperature).toBe(0);
    expect(calls[0]?.params.max_tokens).toBe(2000);
    expect(calls[0]?.options?.timeout).toBe(120_000);

    await model.markdown('write', 'вход');
    expect(calls[1]?.params.temperature).toBe(0.7);
    expect(calls[1]?.params.max_tokens).toBe(4000);
  });

  it('модель роли берётся из своей переменной окружения', async () => {
    const env = testEnv({
      SMM_MODEL_WRITER: 'writer-model',
      SMM_MODEL_JUDGE: 'judge-model',
      SMM_MODEL_RANK: 'rank-model',
    });
    const { model, calls } = setup([{ text: '{"a":1,"b":"да"}' }], { env });
    await model.markdown('write', 'вход');
    await model.json('judge', 'вход', Simple);
    await model.json('rank', 'вход', Simple);
    expect(calls.map((c) => c.params.model)).toEqual(['writer-model', 'judge-model', 'rank-model']);
  });

  it('системный промпт роли — тот, что загружен для неё', async () => {
    const { model, calls } = setup([{ text: '{"a":1,"b":"да"}' }]);
    await model.json('dossier', 'вход', Simple);
    expect(calls[0]?.params.system).toBe('промпт досье');
  });
});

describe('json', () => {
  it('разбирает чистый JSON', async () => {
    const { model } = setup([{ text: '{"a":2,"b":"текст"}' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toEqual({ ok: true, value: { a: 2, b: 'текст' } });
  });

  it('снимает ограждения кода и мусор вокруг', async () => {
    const { model } = setup([{ text: 'Вот ответ:\n```json\n{"a":3,"b":"x"}\n```\nГотово.' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.a).toBe(3);
  });

  it('невалидный JSON даёт ОДИН повтор с текстом ошибки и затем провал', async () => {
    const { model, calls } = setup([{ text: 'не json вовсе' }, { text: 'опять не json' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(calls).toHaveLength(2);
    // В повторе модель видит, ЧТО не подошло.
    const second = calls[1]?.params.messages ?? [];
    expect(second).toHaveLength(3);
    expect(JSON.stringify(second[2])).toContain('Ответ не подошёл');
  });

  it('второй ответ по схеме принимается', async () => {
    const { model, calls } = setup([{ text: '{"a":"строка вместо числа"}' }, { text: '{"a":7,"b":"ок"}' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toEqual({ ok: true, value: { a: 7, b: 'ок' } });
    expect(calls).toHaveLength(2);
  });

  it('текст ошибки схемы попадает в повтор', async () => {
    const { model, calls } = setup([{ text: '{"a":1}' }, { text: '{"a":1,"b":"ок"}' }]);
    await model.json('plan', 'вход', Simple);
    const retry = JSON.stringify(calls[1]?.params.messages ?? []);
    expect(retry).toContain('b');
  });

  it('сетевая ошибка не повторяется и не бросает', async () => {
    // За ретраи транспорта отвечает клиент SDK; второй заход здесь означал бы
    // двойную оплату одного и того же шага.
    const { model, calls } = setup([{ throws: new Error('fetch failed') }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls).toHaveLength(1);
  });

  it('оборванный на лимите ответ не выдаётся за готовый', async () => {
    const { model, calls } = setup([{ text: '{"a":1,', stopReason: 'max_tokens' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toMatchObject({ ok: false, reason: 'truncated' });
    expect(calls).toHaveLength(1);
  });

  it('пустой ответ — провал, а не пустой объект', async () => {
    const { model } = setup([{ text: '' }]);
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('массив в ответе разбирается (ранжирование)', async () => {
    const { model } = setup([{ text: '[{"a":1,"b":"x"}]' }]);
    const result = await model.json('rank', 'вход', z.array(Simple));
    expect(result.ok).toBe(true);
  });
});

describe('markdown', () => {
  it('возвращает текст поста', async () => {
    const { model } = setup([{ text: '# Заголовок\n\nтело' }]);
    const result = await model.markdown('write', 'вход');
    expect(result).toEqual({ ok: true, value: '# Заголовок\n\nтело' });
  });

  it('обрыв на лимите токенов — провал с причиной', async () => {
    const { model } = setup([{ text: '# Заголовок\n\nполовина', stopReason: 'max_tokens' }]);
    const result = await model.markdown('write', 'вход');
    expect(result).toMatchObject({ ok: false, reason: 'truncated' });
  });

  it('пустой ответ — провал', async () => {
    const { model } = setup([{ text: '   ' }]);
    const result = await model.markdown('write', 'вход');
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('учёт расхода', () => {
  const at = (): Date => new Date('2026-09-22T12:00:00.000Z'); // внепик

  it('пишется на каждый ответ, включая неразобранный', async () => {
    const { model, store } = setup([{ text: 'мусор' }, { text: 'опять мусор' }], { now: at });
    await model.json('plan', 'вход', Simple);
    // Два ответа — две строки: токены за них провайдер уже взял.
    const month = store.usage.sumByMonth('2026-09');
    expect(month.calls).toBe(2);
    expect(month.usdMicros).toBeGreaterThan(0);
  });

  it('на сетевой ошибке расхода нет: ответа не было', async () => {
    const { model, store } = setup([{ throws: new Error('terminated') }], { now: at });
    await model.json('plan', 'вход', Simple);
    expect(store.usage.sumByMonth('2026-09').calls).toBe(0);
  });

  it('микродоллары считаются по тарифу внепика', async () => {
    // 1000 входных по $0.15/М + 500 выходных по $0.60/М = 150 + 300 микродолларов.
    const { model, store } = setup([{ text: '{"a":1,"b":"x"}' }], { now: at });
    await model.json('plan', 'вход', Simple);
    expect(store.usage.sumByMonth('2026-09').usdMicros).toBe(450);
  });

  it('в пик тариф вдвое', async () => {
    const peak = (): Date => new Date('2026-09-22T02:00:00.000Z');
    const { model, store } = setup([{ text: '{"a":1,"b":"x"}' }], { now: peak });
    await model.json('plan', 'вход', Simple);
    expect(store.usage.sumByMonth('2026-09').usdMicros).toBe(900);
    expect(store.db.get<{ is_peak: number }>('SELECT is_peak FROM usage LIMIT 1')?.is_peak).toBe(1);
  });

  it('кэш-попадания считаются по своему тарифу', async () => {
    const { model, store } = setup(
      [{ text: '{"a":1,"b":"x"}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } }],
      { now: at },
    );
    await model.json('plan', 'вход', Simple);
    // Миллион кэш-попаданий по $0.003/М = 3000 микродолларов.
    expect(store.usage.sumByMonth('2026-09').usdMicros).toBe(3000);
  });

  it('расход привязывается к посту, а ранжирование идёт без поста', async () => {
    const { model, store } = setup([{ text: '{"a":1,"b":"x"}' }, { text: '[]' }], { now: at });
    await model.json('plan', 'вход', Simple, { postId: 'post-1' });
    await model.json('rank', 'вход', z.array(Simple));
    const rows = store.db.all<{ post_id: string | null; role: string }>(
      'SELECT post_id, role FROM usage ORDER BY id',
    );
    expect(rows).toEqual([
      { post_id: 'post-1', role: 'plan' },
      { post_id: null, role: 'rank' },
    ]);
  });

  it('неизвестная модель помечает сумму как оценочную', async () => {
    const env = testEnv({ SMM_MODEL_WRITER: 'какая-то-новая-модель' });
    const { model, store } = setup([{ text: 'текст' }], { env, now: at });
    await model.markdown('write', 'вход');
    expect(store.usage.sumByMonth('2026-09').hasUnknownPrice).toBe(true);
  });
});

describe('extractJson', () => {
  it('берёт объект из текста с пояснениями', () => {
    expect(extractJson('Ответ: {"a":1} — всё')).toBe('{"a":1}');
  });

  it('берёт массив', () => {
    expect(extractJson('```json\n[1,2]\n```')).toBe('[1,2]');
  });

  it('без JSON возвращает undefined', () => {
    expect(extractJson('совсем не json')).toBeUndefined();
  });

  it('вложенные объекты не обрезаются', () => {
    expect(extractJson('{"a":{"b":[1,2]}}')).toBe('{"a":{"b":[1,2]}}');
  });
});
