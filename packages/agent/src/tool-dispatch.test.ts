import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Диспатч tool_use → обработчик и Zod-граница входов (аудит 2026-08-10, ось L).
 *
 * Это единственное место, где ТЕКСТ, придуманный моделью, превращается в вызов
 * денежной функции: `propose_order` создаёт заказ, `confirm_order` выставляет
 * счёт. Граница обязана (1) звать ровно тот обработчик, который назвала модель,
 * (2) не пропускать вход, не прошедший схему, (3) отдавать ошибку модели, а не
 * ронять весь ход, (4) не звать ничего на неизвестное имя tool'а.
 *
 * `executeToolUse` не экспортируется намеренно — проверяем через `runAgent`,
 * то есть ровно тем путём, которым он работает в проде.
 */

const h = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('./client.ts', () => ({
  getClient: () => ({ messages: { create: h.create } }),
}));

import { runAgent, type ToolHandlers } from './index.ts';

const usage = () => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
});

function makeHandlers() {
  return {
    search_catalog: vi.fn(async () => [{ id: 'svc-1', name: 'Spotify' }]),
    propose_order: vi.fn(async () => ({ orderId: 'o1' })),
    confirm_order: vi.fn(async () => ({ paymentUrl: 'https://pay/1' })),
    request_human: vi.fn(async () => ({ ok: true })),
  } as unknown as ToolHandlers & Record<keyof ToolHandlers, ReturnType<typeof vi.fn>>;
}

function ctxWith(handlers: ToolHandlers) {
  return { userId: 'u1', conversationId: 'c1', channel: 'telegram' as const, toolHandlers: handlers };
}

function toolUse(name: string, input: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name, input }],
    usage: usage(),
  };
}

function finalText(text = 'готово') {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: usage() };
}

/** Один ход: модель зовёт tool, получает результат, отвечает текстом. */
async function runWithToolUse(name: string, input: unknown, handlers: ToolHandlers) {
  h.create.mockResolvedValueOnce(toolUse(name, input)).mockResolvedValueOnce(finalText());
  return runAgent([{ role: 'user', content: 'x' }], ctxWith(handlers));
}

beforeEach(() => {
  h.create.mockReset();
});

describe('диспатч зовёт именно названный обработчик', () => {
  it('search_catalog', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('search_catalog', { query: 'spotify' }, handlers);
    expect(handlers.search_catalog).toHaveBeenCalledWith({ query: 'spotify' });
    expect(handlers.propose_order).not.toHaveBeenCalled();
    expect(handlers.confirm_order).not.toHaveBeenCalled();
  });

  it('propose_order получает разобранный вход, а не сырой input модели', async () => {
    const handlers = makeHandlers();
    await runWithToolUse(
      'propose_order',
      { serviceId: 'svc-1', amountUsdCents: 1199, paymentMethod: 'sbp' },
      handlers,
    );
    expect(handlers.propose_order).toHaveBeenCalledWith({
      serviceId: 'svc-1',
      amountUsdCents: 1199,
      paymentMethod: 'sbp',
    });
  });

  it('confirm_order — денежный вызов уходит ровно один раз', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('confirm_order', { orderId: 'ORD-1' }, handlers);
    expect(handlers.confirm_order).toHaveBeenCalledTimes(1);
    expect(handlers.confirm_order).toHaveBeenCalledWith({ orderId: 'ORD-1' });
  });

  it('request_human: .default(null) применяется — обработчик получает поле', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('request_human', { reason: 'клиент просит оператора' }, handlers);
    expect(handlers.request_human).toHaveBeenCalledWith({
      orderId: null,
      reason: 'клиент просит оператора',
    });
  });
});

describe('Zod-граница: кривой вход модели не доходит до денег', () => {
  it('confirm_order без orderId не зовёт обработчик', async () => {
    const handlers = makeHandlers();
    const res = await runWithToolUse('confirm_order', { paymentMethod: 'sbp' }, handlers);
    expect(handlers.confirm_order).not.toHaveBeenCalled();
    expect(res.toolCalls[0]).toMatchObject({ name: 'confirm_order', isError: true });
  });

  it('propose_order с дробной суммой отклоняется (деньги — целые единицы)', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('propose_order', { serviceId: 's', amountUsdCents: 11.99 }, handlers);
    expect(handlers.propose_order).not.toHaveBeenCalled();
  });

  it('propose_order с отрицательной суммой отклоняется', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('propose_order', { serviceId: 's', amountUsdCents: -500 }, handlers);
    expect(handlers.propose_order).not.toHaveBeenCalled();
  });

  it('строка длиннее .max() схемы отклоняется (advisory-лимиты API не форсятся)', async () => {
    const handlers = makeHandlers();
    await runWithToolUse('search_catalog', { query: 'a'.repeat(201) }, handlers);
    expect(handlers.search_catalog).not.toHaveBeenCalled();
  });

  it('невалидный вход НЕ роняет ход: модель получает ошибку и отвечает', async () => {
    const handlers = makeHandlers();
    const res = await runWithToolUse('confirm_order', {}, handlers);
    expect(res.text).toBe('готово');
    const output = res.toolCalls[0]?.output as { error?: string };
    expect(output.error).toContain('invalid tool input');
  });

  it('лишние поля в input не проносятся в обработчик', async () => {
    // Модель может «дописать» поле — обработчик обязан увидеть только схему.
    const handlers = makeHandlers();
    await runWithToolUse(
      'confirm_order',
      { orderId: 'ORD-1', userId: 'чужой-пользователь' },
      handlers,
    );
    expect(handlers.confirm_order).toHaveBeenCalledWith({ orderId: 'ORD-1' });
  });
});

describe('неизвестный tool', () => {
  it('выдуманное моделью имя не зовёт ни один обработчик и помечается ошибкой', async () => {
    const handlers = makeHandlers();
    const res = await runWithToolUse('refund_everything', { orderId: 'ORD-1' }, handlers);
    for (const fn of Object.values(handlers)) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(res.toolCalls[0]).toMatchObject({ name: 'refund_everything', isError: true });
  });
});

describe('ошибка обработчика', () => {
  it('падение обработчика отдаётся модели как isError, ход продолжается', async () => {
    const handlers = makeHandlers();
    (handlers.confirm_order as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('telegram_link_required: привяжи Telegram'),
    );
    const res = await runWithToolUse('confirm_order', { orderId: 'ORD-1' }, handlers);
    expect(res.toolCalls[0]).toMatchObject({ isError: true });
    expect(res.text).toBe('готово');
  });
});
