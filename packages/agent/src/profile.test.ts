import { describe, expect, it, vi } from 'vitest';

import { AgentLoopError, runProfile, type AgentProfile } from './run.ts';

/**
 * Профиль движка (тикет 02): один цикл обслуживает и продажного агента на
 * Anthropic, и помощника поддержки на DeepSeek. Проверяем ЧТО УШЛО в API и
 * ЧТО ВЕРНУЛОСЬ наружу — не то, какая функция кого позвала.
 *
 * Продажный профиль своими тестами закрыт в `index.test.ts`: он обязан остаться
 * побайтово прежним, поэтому здесь его ожидания не дублируются.
 */

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
});

type Call = Record<string, unknown>;

function makeProfile(
  responses: unknown[],
  over: Partial<AgentProfile> = {},
): { profile: AgentProfile; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const create = vi.fn(async (body: Call) => {
    calls.push(body);
    const next = queue.shift();
    if (next === undefined) throw new Error('в моке кончились ответы');
    if (next instanceof Error) throw next;
    return next;
  });

  const profile: AgentProfile = {
    client: { messages: { create } } as unknown as AgentProfile['client'],
    model: 'deepseek-v4-flash',
    temperature: 0.2,
    maxTokens: 600,
    thinking: { type: 'disabled' },
    system: 'Вы помощник поддержки.',
    tools: [
      {
        name: 'get_my_orders',
        description: 'заказы клиента',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    maxIterations: 4,
    historyCaching: false,
    toolErrorsAsIsError: false,
    maxWebSearchPerRun: 0,
    metadataUserId: 'hash-abc',
    dispatch: async () => ({ result: { ok: true }, isError: false }),
    texts: {
      truncatedNote: '\n\n(Ответ оборвался.)',
      truncatedEmpty: 'Ответ не поместился.',
      noAnswer: 'Не получилось составить ответ.',
    },
    ...over,
  };
  return { profile, calls };
}

const textResponse = (text: string, stopReason: string) => ({
  stop_reason: stopReason,
  content: text ? [{ type: 'text', text }] : [],
  usage: usage(10, 5),
});

const toolUseResponse = (name: string, input: unknown = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu1', name, input }],
  usage: usage(12, 6),
});

/** Содержимое `tool_result`, отправленного следующим запросом. */
function toolResultBlocks(call: Call): Record<string, unknown>[] {
  const messages = call.messages as { role: string; content: unknown }[];
  const last = messages[messages.length - 1];
  return (last?.content as Record<string, unknown>[]) ?? [];
}

describe('runProfile — форма запроса', () => {
  it('thinking передаётся выключенным: с включённым DeepSeek игнорирует temperature', async () => {
    const { profile, calls } = makeProfile([textResponse('готово', 'end_turn')]);
    await runProfile([{ role: 'user', content: 'привет' }], profile);
    expect(calls[0]?.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]?.temperature).toBe(0.2);
  });

  it('system уходит строкой, а не массивом блоков: форма массива у DeepSeek не описана', async () => {
    const { profile, calls } = makeProfile([textResponse('готово', 'end_turn')]);
    await runProfile([{ role: 'user', content: 'привет' }], profile);
    expect(calls[0]?.system).toBe('Вы помощник поддержки.');
  });

  it('cache_control не отправляется: DeepSeek его игнорирует, кэш у него автоматический', async () => {
    const { profile, calls } = makeProfile([textResponse('готово', 'end_turn')]);
    await runProfile([{ role: 'user', content: 'привет' }], profile);
    expect(JSON.stringify(calls[0])).not.toContain('cache_control');
  });

  it('metadata.user_id — переданный хэш, а не telegram_id', async () => {
    const { profile, calls } = makeProfile([textResponse('готово', 'end_turn')]);
    await runProfile([{ role: 'user', content: 'привет' }], profile);
    expect(calls[0]?.metadata).toEqual({ user_id: 'hash-abc' });
  });

  it('без metadataUserId поле metadata не отправляется вовсе', async () => {
    const { profile, calls } = makeProfile([textResponse('готово', 'end_turn')], {
      metadataUserId: undefined,
    });
    await runProfile([{ role: 'user', content: 'привет' }], profile);
    expect(calls[0]).not.toHaveProperty('metadata');
  });
});

describe('runProfile — tool-цикл', () => {
  it('ошибка обработчика возвращается ТЕКСТОМ в tool_result: is_error DeepSeek игнорирует', async () => {
    const { profile, calls } = makeProfile(
      [toolUseResponse('get_my_orders'), textResponse('ответил', 'end_turn')],
      {
        dispatch: async () => ({ result: { error: 'база недоступна' }, isError: true }),
      },
    );

    const res = await runProfile([{ role: 'user', content: 'где заказ' }], profile);

    expect(res.text).toBe('ответил');
    const block = toolResultBlocks(calls[1] as Call)[0];
    expect(block).not.toHaveProperty('is_error');
    expect(String(block?.content)).toContain('база недоступна');
  });

  it('is_error ставится, когда профиль этого просит (продажный на Anthropic)', async () => {
    const { profile, calls } = makeProfile(
      [toolUseResponse('get_my_orders'), textResponse('ответил', 'end_turn')],
      {
        toolErrorsAsIsError: true,
        dispatch: async () => ({ result: { error: 'сбой' }, isError: true }),
      },
    );

    await runProfile([{ role: 'user', content: 'где заказ' }], profile);
    expect(toolResultBlocks(calls[1] as Call)[0]).toHaveProperty('is_error', true);
  });

  it('падение обработчика не роняет ход — становится текстом результата', async () => {
    const { profile, calls } = makeProfile(
      [toolUseResponse('get_my_orders'), textResponse('всё равно ответил', 'end_turn')],
      {
        dispatch: async () => {
          throw new Error('таймаут БД');
        },
      },
    );

    const res = await runProfile([{ role: 'user', content: 'где заказ' }], profile);
    expect(res.text).toBe('всё равно ответил');
    expect(String(toolResultBlocks(calls[1] as Call)[0]?.content)).toContain('таймаут БД');
    expect(res.toolCalls[0]?.isError).toBe(true);
  });

  it('цикл упирается в потолок итераций профиля, а не в чужой', async () => {
    const { profile } = makeProfile(Array.from({ length: 8 }, () => toolUseResponse('get_my_orders')));

    await expect(runProfile([{ role: 'user', content: 'зациклись' }], profile)).rejects.toMatchObject({
      name: 'AgentLoopError',
      reason: 'max_iterations',
    });
  });

  it('ошибка API несёт уже потраченный usage и уже исполненные tools', async () => {
    const { profile } = makeProfile([
      toolUseResponse('get_my_orders'),
      new Error('503 upstream'),
    ]);

    await expect(runProfile([{ role: 'user', content: 'где заказ' }], profile)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentLoopError &&
        err.reason === 'api_error' &&
        err.usage?.input_tokens === 12 &&
        err.toolCalls.length === 1,
    );
  });
});

describe('runProfile — защитный stop_reason', () => {
  it('незнакомый stop_reason трактуется как завершение хода, а не как поломка', async () => {
    const { profile } = makeProfile([textResponse('вот ответ', 'deepseek_specific_reason')]);
    const res = await runProfile([{ role: 'user', content: 'вопрос' }], profile);
    expect(res.text).toBe('вот ответ');
    expect(res.incomplete).toBe(false);
  });

  it('pause_turn без серверных tools — тоже завершение: продолжать нечего', async () => {
    const { profile, calls } = makeProfile([textResponse('сказал половину', 'pause_turn')]);
    const res = await runProfile([{ role: 'user', content: 'вопрос' }], profile);
    expect(res.text).toBe('сказал половину');
    expect(calls).toHaveLength(1);
  });

  it('max_tokens: обрывок помечается, чтобы не читаться как законченная мысль', async () => {
    const { profile } = makeProfile([textResponse('Итого 1 3', 'max_tokens')]);
    const res = await runProfile([{ role: 'user', content: 'сколько' }], profile);
    expect(res.text).toBe('Итого 1 3\n\n(Ответ оборвался.)');
    expect(res.incomplete).toBe(true);
  });

  it('пустой ответ — не молчание: подставляется текст профиля', async () => {
    const { profile } = makeProfile([textResponse('', 'end_turn')]);
    const res = await runProfile([{ role: 'user', content: 'вопрос' }], profile);
    expect(res.text).toBe('Не получилось составить ответ.');
    expect(res.incomplete).toBe(true);
  });
});
