import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadEnv } from '../config/env.ts';
import { smmConfig } from '../config/smm.config.ts';
import { createLogger } from '../logger.ts';
import { openStore } from '../store/index.ts';
import { createModel, extractJson, type MessagesClient } from './model.ts';

/** Дыры, названные ревью тикета 03. Каждая проверка объясняет свой отказ. */

const Simple = z.object({ a: z.number() });

function env() {
  return loadEnv({
    SMM_BOT_TOKEN: '123:abc',
    SMM_OWNER_ID: '1',
    SMM_CHANNEL_ID: '-100123',
    SMM_CHANNEL_USERNAME: 'ooplatishka',
    SMM_MODEL_API_KEY: 'sk-test',
  });
}

function silent(lines: string[] = []) {
  return createLogger({
    level: 'trace',
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
}

function message(partial: Partial<Anthropic.Message> & { text?: string }): Anthropic.Message {
  const { text = '{"a":1}', ...rest } = partial;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Usage,
    ...rest,
  } as Anthropic.Message;
}

function clientOf(reply: Anthropic.Message): { client: MessagesClient; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      messages: {
        create(params, options) {
          calls.push({ params, options });
          return Promise.resolve(reply);
        },
      },
    },
  };
}

describe('обещание «никогда не бросает»', () => {
  it('падение записи расхода не роняет вызов', async () => {
    // Ответ уже оплачен: потеря строки учёта дешевле потери поста.
    const lines: string[] = [];
    const logger = silent(lines);
    const { client } = clientOf(message({}));
    const model = createModel({
      client,
      env: env(),
      logger,
      usage: {
        add() {
          throw new Error('база закрыта');
        },
        sumByMonth() {
          throw new Error('не нужно');
        },
        countSince() {
          return 0;
        },
      },
    });
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    expect(lines.join('')).toContain('расход не записался');
  });

  it('ответ без поля usage не роняет вызов', async () => {
    // Маппинг usage у Anthropic-совместимого слоя DeepSeek не документирован.
    const store = openStore({ path: ':memory:' });
    const { client } = clientOf(message({ usage: undefined as unknown as Anthropic.Usage }));
    const model = createModel({ client, env: env(), logger: silent(), usage: store.usage });
    const result = await model.json('plan', 'вход', Simple);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    // Строка учёта всё равно есть, просто с нулями.
    expect(store.usage.sumByMonth(new Date().toISOString().slice(0, 7)).calls).toBe(1);
    store.close();
  });

  it('отрицательные токены не занижают сводку', async () => {
    const store = openStore({ path: ':memory:' });
    const { client } = clientOf(
      message({
        usage: {
          input_tokens: -5,
          output_tokens: -1,
          cache_read_input_tokens: -100,
        } as unknown as Anthropic.Usage,
      }),
    );
    const model = createModel({ client, env: env(), logger: silent(), usage: store.usage });
    await model.json('plan', 'вход', Simple);
    const month = store.usage.sumByMonth(new Date().toISOString().slice(0, 7));
    expect(month.usdMicros).toBe(0);
    store.close();
  });
});

describe('имя модели берётся из ответа', () => {
  it('подмена модели провайдером видна в учёте и в логе', async () => {
    // Провайдер молча маппит незнакомый id на свою модель: опечатка в env
    // иначе выглядит рабочей настройкой «судья теперь другой».
    const lines: string[] = [];
    const store = openStore({ path: ':memory:' });
    const { client } = clientOf(message({ model: 'deepseek-flash' }));
    const model = createModel({
      client,
      env: loadEnv({
        SMM_BOT_TOKEN: '123:abc',
        SMM_OWNER_ID: '1',
        SMM_CHANNEL_ID: '-100123',
        SMM_CHANNEL_USERNAME: 'ooplatishka',
        SMM_MODEL_API_KEY: 'sk-test',
        SMM_MODEL_JUDGE: 'deepsek-flash-опечатка',
      }),
      logger: silent(lines),
      usage: store.usage,
    });
    await model.json('judge', 'вход', Simple);
    expect(lines.join('')).toContain('провайдер ответил другой моделью');
    const row = store.db.get<{ model: string }>('SELECT model FROM usage LIMIT 1');
    expect(row?.model).toBe('deepseek-flash');
    store.close();
  });
});

describe('срок запроса', () => {
  it('таймаут покрывает чтение тела: запрос уходит с signal', async () => {
    // Одного `timeout` мало: SDK снимает таймер после заголовков, и молчание
    // на теле вешало бы шаг навсегда.
    const store = openStore({ path: ':memory:' });
    const { client, calls } = clientOf(message({}));
    const model = createModel({ client, env: env(), logger: silent(), usage: store.usage });
    await model.json('plan', 'вход', Simple);
    const options = (calls[0] as { options?: { signal?: AbortSignal; timeout?: number } }).options;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBe(smmConfig.roles.plan.timeoutMs);
    store.close();
  });

  it('сроки ролей различаются: короткий шаг не ждёт как длинный', () => {
    expect(smmConfig.roles.plan.timeoutMs).toBeLessThan(smmConfig.roles.write.timeoutMs);
  });
});

describe('extractJson: проза со скобками', () => {
  it('находит JSON, когда после него идёт фраза с фигурной скобкой', () => {
    // Именно так модель теряла валидный ответ: «в поле {link}» после JSON.
    expect(extractJson('```json\n{"a":1}\n```\nЕсли нужно {другое}, скажи.')).toBe('{"a":1}');
    expect(extractJson('{"a":1}\n\nПояснение: формат {ключ: значение}')).toBe('{"a":1}');
    expect(extractJson('Смотри {тут} — {"a":1}')).toBe('{"a":1}');
    expect(extractJson('Список: [1,2] и заметка {всё}')).toBe('[1,2]');
  });

  it('вложенные скобки внутри строк JSON не сбивают разбор', () => {
    const raw = '{"note":"формат {ключ} и скобка ]","a":1}';
    expect(extractJson(raw)).toBe(raw);
  });

  it('экранированная кавычка внутри строки не сбивает разбор', () => {
    const raw = '{"note":"он сказал \\"да\\"","a":1}';
    expect(extractJson(raw)).toBe(raw);
  });

  it('незакрытая скобка не считается JSON', () => {
    expect(extractJson('{"a":1')).toBeUndefined();
  });
});
