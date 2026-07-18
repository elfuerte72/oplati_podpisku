import type Anthropic from '@anthropic-ai/sdk';
import {
  confirmOrderInput,
  proposeOrderInput,
  requestHumanInput,
  searchCatalogInput,
} from '@oplati/types';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';

import { getClient } from './client.ts';
import { SYSTEM_PROMPT } from './prompts.ts';
import { tools } from './tools.ts';

export { SYSTEM_PROMPT, GREETING } from './prompts.ts';
export { tools } from './tools.ts';
export {
  classifyMessage,
  isRouterEnabled,
  parseRouterLabel,
  CANNED_REPLIES,
  type RouteDecision,
  type RouteKind,
} from './router.ts';

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
  /**
   * Субтотал в копейках RUB — БЕЗ комиссии (цена сервиса по курсу). К оплате
   * идёт `totalRubKopecks` (= subtotal + commission). Имя историческое; не путать
   * с суммой счёта L&P, которая равна `totalRubKopecks`.
   */
  amountRubKopecks: number;
  commissionKopecks: number;
  totalRubKopecks: number;
  rateUsdRubKopecks: number;
  /**
   * Оригинальная цена подписки в USD-центах (сколько клиент вводит на сайте
   * сервиса, по цене США). Показывается в карточке заказа рядом с рублёвым
   * «к оплате» — доллар-оригинал + рублёвый чек.
   */
  originalAmountUsdCents: number;
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

/**
 * Zod-схемы входов наших tools — валидируют сырой `tool_use.input` модели ДО
 * вызова обработчика (инвариант «Zod на всех границах, включая AI tool inputs»).
 * `web_search` — server-side tool Anthropic, обработчика у нас нет, поэтому его
 * здесь нет. Ключи обязаны совпадать с именами tools в `./tools.ts`.
 *
 * `satisfies` (M-8 аудита) форсит двумя способами: (1) полноту — новый tool в
 * `ToolHandlers` без схемы не соберётся, раньше он тихо проскакивал Zod-границу;
 * (2) совпадение типа выхода схемы со входом обработчика.
 */
const TOOL_INPUT_SCHEMAS = {
  search_catalog: searchCatalogInput,
  propose_order: proposeOrderInput,
  confirm_order: confirmOrderInput,
  request_human: requestHumanInput,
} satisfies {
  // Вход схемы — unknown (сырой tool_use.input модели; .default() делает вход
  // шире выхода), выход обязан совпадать со входом обработчика.
  [K in keyof ToolHandlers]: ZodType<Parameters<ToolHandlers[K]>[0], ZodTypeDef, unknown>;
};

function isKnownTool(name: string): name is keyof ToolHandlers {
  return Object.hasOwn(TOOL_INPUT_SCHEMAS, name);
}

type ToolExecution = { result: unknown; isError: boolean };

function invalidToolInput(error: ZodError): ToolExecution {
  return { result: { error: `invalid tool input: ${error.message}` }, isError: true };
}

/**
 * Типизированный диспатч tool_use → обработчик (вместо прежнего
 * `(handler as any)(input)`): в каждой ветке компилятор сверяет выход схемы со
 * входом конкретного обработчика. `default` с `never` делает switch
 * экзостивным — новый tool без ветки не соберётся.
 */
async function executeToolUse(
  handlers: ToolHandlers,
  name: keyof ToolHandlers,
  rawInput: unknown,
): Promise<ToolExecution> {
  switch (name) {
    case 'search_catalog': {
      const parsed = TOOL_INPUT_SCHEMAS.search_catalog.safeParse(rawInput);
      if (!parsed.success) return invalidToolInput(parsed.error);
      return { result: await handlers.search_catalog(parsed.data), isError: false };
    }
    case 'propose_order': {
      const parsed = TOOL_INPUT_SCHEMAS.propose_order.safeParse(rawInput);
      if (!parsed.success) return invalidToolInput(parsed.error);
      return { result: await handlers.propose_order(parsed.data), isError: false };
    }
    case 'confirm_order': {
      const parsed = TOOL_INPUT_SCHEMAS.confirm_order.safeParse(rawInput);
      if (!parsed.success) return invalidToolInput(parsed.error);
      return { result: await handlers.confirm_order(parsed.data), isError: false };
    }
    case 'request_human': {
      const parsed = TOOL_INPUT_SCHEMAS.request_human.safeParse(rawInput);
      if (!parsed.success) return invalidToolInput(parsed.error);
      return { result: await handlers.request_human(parsed.data), isError: false };
    }
    default: {
      const unreachable: never = name;
      throw new Error(`unhandled tool: ${String(unreachable)}`);
    }
  }
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
  /**
   * Имя tool'а из `tool_use` модели. Для наших tools совпадает с ключом
   * `ToolHandlers`; тип `string`, потому что модель может назвать
   * несуществующий tool — такой вызов логируется здесь с `isError: true`.
   */
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

/**
 * System prompt как блок с cache_control — включает prompt caching Anthropic.
 * Брейкпоинт на последнем system-блоке кэширует префикс tools + system целиком
 * (порядок рендера: tools → system → messages): повторные вызовы — и итерации
 * tool-loop внутри одного runAgent, и следующие сообщения диалога в пределах
 * TTL 5 минут — читают его по ~0.1x цены input-токенов и обрабатываются быстрее.
 * ВАЖНО: ничего динамического (дата, имя, id) в SYSTEM_PROMPT не вставлять —
 * любое изменение префикса инвалидирует кэш. Проверка хитов:
 * usage.cache_read_input_tokens в ответе (логируется в web-chat/telegram).
 */
const CACHED_SYSTEM: Anthropic.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

/** Сквозной потолок web_search-запросов на один runAgent (см. использование). */
const MAX_WEB_SEARCH_PER_RUN = 3;

/**
 * Второй cache-брейкпоинт — на истории диалога (первый — CACHED_SYSTEM выше).
 * Возвращает копию `messages`, где последний content-блок последнего сообщения
 * помечен `cache_control` — кэшируется весь префикс разговора целиком.
 *
 * Брейкпоинт «едет» вперёд с каждым вызовом: предыдущие позиции Anthropic
 * находит сам (автоматический lookup по ~20 последним блокам), поэтому держим
 * ровно один маркер в messages и не упираемся в лимит 4 брейкпоинтов на запрос.
 *
 * Экономия двойная: итерации tool-loop внутри одного runAgent не платят
 * повторно за историю и результаты web_search (самая «толстая» часть input),
 * а следующие ходы активного диалога в пределах TTL 5 минут читают весь
 * префикс по ~0.1x цены.
 *
 * Последним сообщением здесь бывает только user-текст (string) или наш
 * tool_result — оба типа поддерживают cache_control. assistant-блоки из
 * response.content последними не бывают (после них всегда пушится tool_result).
 */
function withHistoryCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;

  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : [...last.content];

  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock) return messages;

  // Спред union-типа + опциональное поле cache_control есть у всех param-блоков,
  // которые реально оказываются последними (text / tool_result) — каст безопасен.
  blocks[blocks.length - 1] = {
    ...lastBlock,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.ContentBlockParam;

  return [...messages.slice(0, -1), { role: last.role, content: blocks }];
}

/**
 * Суммирование usage по итерациям tool-loop (и Haiku-роутера на call-site):
 * каждая итерация — отдельный billable-вызов API, поэтому для честного учёта
 * расходов (дневной токен-бюджет в apps/web/lib/ai/budget.ts) складываем все
 * числовые счётчики. Остальные поля (`service_tier` и т.п.) берутся из
 * последнего ответа через спред.
 */
function addUsage(total: Anthropic.Usage | null, u: Anthropic.Usage): Anthropic.Usage {
  if (!total) return { ...u };
  return {
    ...u,
    input_tokens: total.input_tokens + u.input_tokens,
    output_tokens: total.output_tokens + u.output_tokens,
    cache_creation_input_tokens:
      (total.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (total.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    server_tool_use: {
      web_search_requests:
        (total.server_tool_use?.web_search_requests ?? 0) +
        (u.server_tool_use?.web_search_requests ?? 0),
      web_fetch_requests:
        (total.server_tool_use?.web_fetch_requests ?? 0) +
        (u.server_tool_use?.web_fetch_requests ?? 0),
    },
  };
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
 * Возвращает финальный текст для отправки пользователю + usage, просуммированный
 * по ВСЕМ итерациям tool-loop (для учёта расходов), + лог вызовов tools.
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
  let totalUsage: Anthropic.Usage | null = null;
  // Сквозной потолок web_search на ОДИН runAgent. `max_uses: 2` в tools.ts —
  // это лимит на один вызов API, а tool-loop делает до 6 итераций, поэтому без
  // этого счётчика дорогой web_search мог бы сработать до 12 раз за разговор.
  // По достижении лимита убираем web_search из набора tools на следующих шагах.
  let webSearchUsed = 0;

  // Максимум 6 итераций tool use (план MVP, раздел 5.3).
  for (let step = 0; step < 6; step++) {
    const toolsForStep =
      webSearchUsed >= MAX_WEB_SEARCH_PER_RUN
        ? tools.filter((t) => t.name !== 'web_search')
        : tools;
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: CACHED_SYSTEM,
      tools: toolsForStep,
      messages: withHistoryCacheBreakpoint(messages),
    });
    totalUsage = addUsage(totalUsage, response.usage);
    webSearchUsed += response.usage.server_tool_use?.web_search_requests ?? 0;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        let result: unknown;
        let isError = false;
        try {
          if (isKnownTool(tu.name)) {
            // Zod-граница: executeToolUse валидирует сырой input модели ДО
            // обработчика. Провал (напр. customDescription длиннее лимита,
            // отрицательная сумма) → is_error tool_result, обработчик мусор
            // не получает (L6).
            const execution = await executeToolUse(ctx.toolHandlers, tu.name, tu.input);
            result = execution.result;
            isError = execution.isError;
          } else {
            // Галлюцинация модели: несуществующий tool → is_error, не падение цикла.
            isError = true;
            result = { error: `unknown tool: ${tu.name}` };
          }
        } catch (err) {
          isError = true;
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolCalls.push({
          name: tu.name,
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

    return { text, usage: totalUsage, toolCalls };
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
    system: CACHED_SYSTEM,
    messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return { text, usage: response.usage };
}
