import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompts.ts';
import { tools } from './tools.ts';

export { SYSTEM_PROMPT, GREETING } from './prompts.ts';
export { tools } from './tools.ts';

/**
 * Контракт для инструментов — apps/web подставляет реальные реализации
 * (потому что tools требуют доступ к БД/сервисам, которые не должны быть в agent).
 */
export interface ToolHandlers {
  search_catalog: (input: { query: string; category?: string }) => Promise<unknown>;
  propose_order: (input: Record<string, unknown>) => Promise<unknown>;
  confirm_order: (input: { orderId: string; paymentMethod: string }) => Promise<unknown>;
  request_human: (input: { reason: string; context: string }) => Promise<unknown>;
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

let _client: Anthropic | undefined;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Один круг разговора с AI.
 * Возвращает финальный текст для отправки пользователю + сырой ответ Anthropic.
 * Вызов инструментов делается через ctx.toolHandlers — apps/web решает, что там внутри.
 */
export async function runAgent(
  history: AgentMessage[],
  ctx: AgentContext,
): Promise<{ text: string; usage: Anthropic.Usage }> {
  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-6';

  // Агентский цикл: модель может запросить tools, мы исполняем, возвращаем
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Максимум 5 итераций tool use, чтобы не зациклиться
  for (let step = 0; step < 5; step++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
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
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await (handler as any)(tu.input);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
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

    return { text, usage: response.usage };
  }

  throw new Error('Agent tool-use loop exceeded 5 iterations');
}
