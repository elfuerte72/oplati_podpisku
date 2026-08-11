import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('./client.ts', () => ({
  getClient: () => ({ messages: { create: h.create } }),
}));

import { AgentLoopError, runAgent, type ToolHandlers } from './index.ts';

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
});

const handlers: ToolHandlers = {
  search_catalog: vi.fn(async () => []),
  propose_order: vi.fn() as unknown as ToolHandlers['propose_order'],
  confirm_order: vi.fn() as unknown as ToolHandlers['confirm_order'],
  request_human: vi.fn() as unknown as ToolHandlers['request_human'],
};

const ctx = {
  userId: 'u1',
  conversationId: 'c1',
  channel: 'telegram' as const,
  toolHandlers: handlers,
};

function textResponse(text: string, stopReason: string, u = usage(10, 5)) {
  return {
    stop_reason: stopReason,
    content: text ? [{ type: 'text', text }] : [],
    usage: u,
  };
}

/**
 * Реалистичный `pause_turn`: живой API отдаёт вместе с паузой уже сказанный
 * текст и блоки серверного поиска. Пустой `content` он не присылает, и тест на
 * такой форме проходил бы при любом состоянии кода.
 */
function pausedSearchResponse(said: string, u = usage(20, 8)) {
  return {
    stop_reason: 'pause_turn',
    content: [
      { type: 'text', text: said },
      { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'spotify' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
    ],
    usage: { ...u, server_tool_use: { web_search_requests: 1 } },
  };
}

function toolUseResponse(u = usage(100, 50)) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'search_catalog', input: { query: 'x' } }],
    usage: u,
  };
}

describe('runAgent: usage не теряется при сбое', () => {
  beforeEach(() => {
    h.create.mockReset();
  });

  /**
   * Дневной токен-бюджет считается по `usage`, который возвращает runAgent. При
   * `throw` он терялся ЦЕЛИКОМ — то есть самые дорогие запросы (шесть итераций
   * Sonnet, упавших на седьмой) записывались как ноль токенов, и защита расходов
   * слепла ровно на том, от чего защищает (аудит 2026-08-10, HIGH).
   */
  it('падение API на 2-й итерации отдаёт usage первой', async () => {
    h.create
      .mockResolvedValueOnce(toolUseResponse(usage(100, 50)))
      .mockRejectedValueOnce(new Error('529 overloaded'));

    const err = await runAgent([{ role: 'user', content: 'привет' }], ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentLoopError);
    const loopErr = err as AgentLoopError;
    expect(loopErr.usage).toMatchObject({ input_tokens: 100, output_tokens: 50 });
    expect(loopErr.cause).toBeInstanceOf(Error);
  });

  it('исчерпание итераций тоже несёт накопленный usage', async () => {
    h.create.mockResolvedValue(toolUseResponse(usage(10, 5)));

    const err = (await runAgent([{ role: 'user', content: 'привет' }], ctx).catch(
      (e: unknown) => e,
    )) as AgentLoopError;

    expect(err).toBeInstanceOf(AgentLoopError);
    // Шесть итераций по 10/5.
    expect(err.usage).toMatchObject({ input_tokens: 60, output_tokens: 30 });
  });
});

describe('runAgent: stop_reason', () => {
  beforeEach(() => {
    h.create.mockReset();
  });

  /**
   * `pause_turn` приходит от серверного `web_search`, когда модель просит
   * продолжить ход. Раньше он проваливался в ветку «end_turn» и отдавался как
   * финальный ответ — то есть пустой текст, а в боте это молчание.
   */
  it('pause_turn продолжает ход, а не завершает его', async () => {
    h.create
      .mockResolvedValueOnce(pausedSearchResponse('Spotify Premium — $11.99/мес'))
      .mockResolvedValueOnce(textResponse('Итого 1 350 ₽. Оформляем?', 'end_turn'));

    const res = await runAgent([{ role: 'user', content: 'сколько стоит spotify' }], ctx);

    expect(h.create).toHaveBeenCalledTimes(2);
    // Сказанное ДО паузы не теряется: без него сумма появляется из ниоткуда.
    expect(res.text).toContain('$11.99');
    expect(res.text).toContain('Итого 1 350 ₽');
    expect(res.incomplete).toBe(false);
  });

  it('продолжение хода отправляется с тем же набором tools', async () => {
    // В истории уже лежат server_tool_use/web_search_tool_result: отправить их
    // без объявленного web_search — верный 400 от API.
    h.create
      .mockResolvedValueOnce(pausedSearchResponse('ищу...'))
      .mockResolvedValueOnce(textResponse('нашёл', 'end_turn'));

    await runAgent([{ role: 'user', content: 'сколько стоит spotify' }], ctx);

    const secondCall = h.create.mock.calls[1]?.[0] as { tools: { name: string }[] };
    expect(secondCall.tools.map((t) => t.name)).toContain('web_search');
  });

  it('паузы не съедают бюджет tool-итераций', async () => {
    // Иначе разговор с несколькими поисками упирался бы в потолок вместо ответа.
    for (let i = 0; i < 3; i++) h.create.mockResolvedValueOnce(pausedSearchResponse(`шаг ${i}`));
    h.create.mockResolvedValueOnce(toolUseResponse(usage(1, 1)));
    h.create.mockResolvedValueOnce(textResponse('готово', 'end_turn'));

    const res = await runAgent([{ role: 'user', content: 'сравни цены' }], ctx);

    expect(res.text).toContain('готово');
  });

  it('max_tokens не оставляет клиента без ответа', async () => {
    h.create.mockResolvedValueOnce(textResponse('', 'max_tokens'));

    const res = await runAgent([{ role: 'user', content: 'расскажи всё' }], ctx);

    expect(res.text.trim()).not.toHaveLength(0);
    // Флаг обязателен: по нему call-site не приклеит к служебному тексту кнопку
    // «Подтвердить» — иначе клиент оплатит сумму, которой в сообщении нет.
    expect(res.incomplete).toBe(true);
  });

  it('refusal и прочие неизвестные причины тоже не дают молчания', async () => {
    h.create.mockResolvedValueOnce(textResponse('', 'refusal'));
    const res = await runAgent([{ role: 'user', content: '...' }], ctx);
    expect(res.text.trim()).not.toHaveLength(0);
    expect(res.incomplete).toBe(true);
  });

  it('ошибка цикла несёт уже выполненные tool-вызовы', async () => {
    // Среди них может быть confirm_order — то есть выставленный счёт с живой
    // ссылкой. Выбросить их вместе с ошибкой значит спрятать деньги.
    h.create
      .mockResolvedValueOnce(toolUseResponse(usage(1, 1)))
      .mockRejectedValueOnce(new Error('529 overloaded'));

    const err = (await runAgent([{ role: 'user', content: 'x' }], ctx).catch(
      (e: unknown) => e,
    )) as AgentLoopError;

    expect(err.toolCalls.map((c) => c.name)).toContain('search_catalog');
  });

  it('обрезанный по max_tokens текст доезжает с пометкой', async () => {
    h.create.mockResolvedValueOnce(textResponse('начало ответа', 'max_tokens'));

    const res = await runAgent([{ role: 'user', content: 'расскажи всё' }], ctx);

    expect(res.text).toContain('начало ответа');
    // Обрыв на полуслове без пометки читается как законченная мысль.
    expect(res.text.length).toBeGreaterThan('начало ответа'.length);
  });

  it('обычный end_turn работает как прежде', async () => {
    h.create.mockResolvedValueOnce(textResponse('привет!', 'end_turn'));
    const res = await runAgent([{ role: 'user', content: 'привет' }], ctx);
    expect(res.text).toBe('привет!');
    expect(res.incomplete).toBe(false);
    expect(res.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});
