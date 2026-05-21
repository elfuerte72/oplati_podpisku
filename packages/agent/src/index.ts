import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompts.ts';
import { tools } from './tools.ts';

export { SYSTEM_PROMPT, GREETING } from './prompts.ts';
export { tools } from './tools.ts';

/**
 * Контракт инструментов AI-агента (MVP: Love & Pay + app.pay.space).
 * Реализация — `apps/web/lib/tool-handlers/`; agent её не импортирует, чтобы
 * пакет оставался без зависимостей от БД (CLAUDE.md, граница пакетов).
 *
 * Результаты сериализуются в `tool_result` и подаются обратно в модель —
 * структуру держим стабильной.
 */
export interface CatalogItem {
  id: string;
  slug: string;
  name: string;
  requiresKyc: boolean;
}

export interface ProposeOrderResult {
  orderId: string;
  shortId: string;
  amountRubKopecks: number;
  commissionKopecks: number;
  totalRubKopecks: number;
  rateUsdRubKopecks: number;
  expiresAt: string;
  /**
   * true — заказ создан без `serviceId` (через `customDescription`).
   * Используется промптом, чтобы упомянуть «оператор перепроверит цену».
   */
  isCustom: boolean;
}

export interface ConfirmOrderResult {
  paymentUrl: string;
  qrPayload: string | null;
  expiresAt: string;
}

export interface ToolHandlers {
  search_catalog: (input: { query: string }) => Promise<CatalogItem[]>;
  propose_order: (input: {
    serviceId?: string;
    customDescription?: string;
    serviceName?: string;
    amountUsdCents: number;
    paymentMethod?: 'sbp' | 'card';
  }) => Promise<ProposeOrderResult>;
  confirm_order: (input: {
    orderId: string;
    paymentMethod?: 'sbp' | 'card';
  }) => Promise<ConfirmOrderResult>;
  request_human: (input: {
    orderId: string | null;
    reason: string;
  }) => Promise<{
    acknowledged: true;
    slaHours: number;
    withinBusinessHours: boolean;
    duplicate?: true;
  }>;
}

export interface AgentContext {
  userId: string;
  conversationId: string;
  channel: 'telegram' | 'web';
  toolHandlers: ToolHandlers;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Лог вызова tool'а внутри одного `runAgent()`. Возвращается наружу, чтобы
 * call-site (handle-update.ts) мог среагировать на конкретный tool — например,
 * после `propose_order` прикрепить inline-кнопки с orderId к ответному сообщению.
 */
export interface ToolCallLog {
  name: keyof ToolHandlers;
  input: unknown;
  output: unknown;
  isError: boolean;
}

let _client: Anthropic | undefined;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Параметры модели — читаются из ENV с дефолтами. Валидация — в apps/web/lib/env.ts
 * (Zod-схема), здесь только разумные fallback'и на случай standalone-использования.
 */
function getModelParams(): { temperature: number; maxTokens: number } {
  const t = Number.parseFloat(process.env.ANTHROPIC_TEMPERATURE ?? '');
  const m = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '', 10);
  return {
    temperature: Number.isFinite(t) ? t : 0.3,
    maxTokens: Number.isFinite(m) && m > 0 ? m : 2048,
  };
}

/**
 * Один круг разговора с AI.
 * Возвращает финальный текст для отправки пользователю + сырой ответ Anthropic.
 * Вызов инструментов делается через ctx.toolHandlers — apps/web решает, что там внутри.
 */
export async function runAgent(
  history: AgentMessage[],
  ctx: AgentContext,
): Promise<{ text: string; usage: Anthropic.Usage; toolCalls: ToolCallLog[] }> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const { temperature, maxTokens } = getModelParams();

  // Агентский цикл: модель может запросить tools, мы исполняем, возвращаем
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const toolCalls: ToolCallLog[] = [];

  // Максимум 6 итераций tool use (план MVP, раздел 5.3).
  for (let step = 0; step < 6; step++) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        const handler = ctx.toolHandlers[tu.name as keyof ToolHandlers];
        let result: unknown;
        let isError = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await (handler as any)(tu.input);
        } catch (err) {
          isError = true;
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolCalls.push({
          name: tu.name as keyof ToolHandlers,
          input: tu.input,
          output: result,
          isError,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason === 'end_turn' — возвращаем текст
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return { text, usage: response.usage, toolCalls };
  }

  throw new Error('Agent tool-use loop exceeded 6 iterations');
}

/**
 * Один round-trip с Claude БЕЗ tools — для milestone «Telegram webhook + AI v1».
 *
 * Используется на Sprint 1.5, когда схема БД (`users`, `conversations`,
 * `messages`) и ToolHandlers ещё не готовы. История диалога подаётся снаружи
 * (stateless: серверу не на чем её хранить до появления БД).
 *
 * Контракт: `messages` — пользовательско-агентская переписка; `system` —
 * `SYSTEM_PROMPT` консультанта. Tools НЕ передаются, поэтому модель никогда
 * не вернёт `stop_reason === 'tool_use'`. Если по какой-то причине вернёт —
 * это баг провайдера; режем по `end_turn`.
 */
export async function runAgentNoTools(
  history: AgentMessage[],
): Promise<{ text: string; usage: Anthropic.Usage }> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const { temperature, maxTokens } = getModelParams();

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: SYSTEM_PROMPT,
    messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return { text, usage: response.usage };
}
