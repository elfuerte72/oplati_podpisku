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
import {
  AgentLoopError,
  collectText,
  runProfile,
  type AgentMessage,
  type AgentProfile,
  type AgentRunResult,
  type ToolCallLog,
  type ToolExecution,
} from './run.ts';

export { SYSTEM_PROMPT, GREETING } from './prompts.ts';
export { tools } from './tools.ts';
export {
  AgentLoopError,
  runProfile,
  type AgentClient,
  type AgentFallbackTexts,
  type AgentMessage,
  type AgentProfile,
  type AgentRunResult,
  type ToolCallLog,
  type ToolExecution,
} from './run.ts';
export {
  buildSupportKnowledgeBase,
  buildSupportSystemPrompt,
  type SupportFacts,
} from './support-prompt.ts';
export {
  getSupportClient,
  isSupportAiConfigured,
  supportModel,
  SUPPORT_AI_DEFAULT_BASE_URL,
  SUPPORT_AI_DEFAULT_MODEL,
} from './client.ts';
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

/** Сквозной потолок web_search-запросов на один runAgent. */
const MAX_WEB_SEARCH_PER_RUN = 3;

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
 * Что дописываем, когда модель упёрлась в `max_tokens`.
 *
 * Обрыв на полуслове без пометки читается как законченная мысль — клиент верит
 * половине ответа. А пустой ответ (модель истратила лимит на рассуждение, текста
 * не осталось) в боте выглядит просто молчанием.
 */
const TRUNCATED_NOTE = '\n\n(Ответ получился длинным и оборвался. Спроси про нужную часть — договорю.)';
const TRUNCATED_EMPTY =
  'Ответ получился слишком длинным и не поместился. Задай вопрос поконкретнее — отвечу коротко.';

/**
 * Когда текста нет вообще, а причина — не `max_tokens`.
 *
 * Сюда попадает `refusal` (сработал классификатор отказа) и любой будущий
 * `stop_reason`, о котором мы ещё не знаем. Перечислять причины по одной
 * бессмысленно: важен факт «сказать нечего», а молчание бота выглядит поломкой
 * (ревью 2026-08-11).
 */
const NO_ANSWER_TEXT =
  'Не получилось составить ответ на это сообщение. Переформулируй, пожалуйста, — или напиши /support, и подключу человека.';

/**
 * Профиль продажного агента — сегодняшние значения без единого изменения:
 * Anthropic, `SYSTEM_PROMPT` с cache_control, серверный `web_search`, шесть
 * итераций цикла, `is_error` в `tool_result`.
 *
 * Собирается на каждый ход, потому что несёт обработчики конкретного вызова.
 */
export function buildSalesProfile(ctx: AgentContext): AgentProfile {
  // `||`, а не `??`: `KEY=` в env — это «не задано» (см. withoutEmptyValues в
  // apps/web/lib/env.ts). С `??` пустая строка уходила бы в Messages API как
  // имя модели, и КАЖДЫЙ ответ падал бы с 400 при зелёной валидации env.
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const { temperature, maxTokens } = getModelParams();

  return {
    client: getClient(),
    model,
    temperature,
    maxTokens,
    system: CACHED_SYSTEM,
    tools,
    maxIterations: 6,
    historyCaching: true,
    toolErrorsAsIsError: true,
    maxWebSearchPerRun: MAX_WEB_SEARCH_PER_RUN,
    dispatch: async (name, rawInput) => {
      if (!isKnownTool(name)) {
        // Галлюцинация модели: несуществующий tool → ошибка результата, не
        // падение цикла.
        return { result: { error: `unknown tool: ${name}` }, isError: true };
      }
      // Zod-граница: executeToolUse валидирует сырой input модели ДО
      // обработчика. Провал (напр. customDescription длиннее лимита,
      // отрицательная сумма) → ошибка в tool_result, обработчик мусор не
      // получает (L6).
      return await executeToolUse(ctx.toolHandlers, name, rawInput);
    },
    texts: {
      truncatedNote: TRUNCATED_NOTE,
      truncatedEmpty: TRUNCATED_EMPTY,
      noAnswer: NO_ANSWER_TEXT,
    },
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
): Promise<AgentRunResult> {
  return await runProfile(history, buildSalesProfile(ctx));
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
): Promise<{ text: string; usage: Anthropic.Usage; incomplete: boolean }> {
  const client = getClient();
  // `||` — по той же причине, что в runAgent: пустая строка = «не задано».
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
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

  const text = collectText(response.content);

  // Те же правила, что в runAgent (ревью 2026-08-11). Этот путь — деградация
  // при недоступной БД, то есть режим, где ошибиться дороже всего: обрывок на
  // полуслове там читается как законченная мысль («…с комиссией получается
  // 1 3»), а пустой ответ — как молчание бота.
  if (response.stop_reason === 'max_tokens') {
    return {
      text: text.trim() ? `${text}${TRUNCATED_NOTE}` : TRUNCATED_EMPTY,
      usage: response.usage,
      incomplete: true,
    };
  }
  if (!text.trim()) {
    return { text: NO_ANSWER_TEXT, usage: response.usage, incomplete: true };
  }

  return { text, usage: response.usage, incomplete: false };
}
