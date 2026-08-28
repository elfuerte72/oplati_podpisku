import type Anthropic from '@anthropic-ai/sdk';

/**
 * Движок AI-хода: один tool-цикл на два сценария.
 *
 * Продажный агент (Anthropic, tools заказа, prompt caching, серверный
 * `web_search`) и помощник поддержки (DeepSeek через Anthropic-совместимый
 * endpoint, read-only tools, thinking выключен, кэш не отправляется) отличаются
 * НАСТРОЙКАМИ, а не логикой. Третья копия оркестрации хода означала бы, что
 * защитный разбор `stop_reason` и учёт usage при сбое правятся в трёх местах —
 * а чинят обычно одно.
 *
 * Всё, что различается, живёт в `AgentProfile`; цикл о конкретных tools и
 * конкретном провайдере ничего не знает.
 */

/** Узкий вид клиента SDK — чтобы тесты подставляли фейк без каста всего Anthropic. */
export interface AgentClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** Результат исполнения одного `tool_use`. */
export type ToolExecution = { result: unknown; isError: boolean };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Лог вызова tool'а внутри одного хода. Возвращается наружу, чтобы call-site
 * мог среагировать на конкретный tool — например, после `propose_order`
 * прикрепить inline-кнопки с orderId, а после `request_human` — эскалировать.
 */
export interface ToolCallLog {
  /**
   * Имя tool'а из `tool_use` модели. Для наших tools совпадает с ключом
   * обработчиков; тип `string`, потому что модель может назвать
   * несуществующий tool — такой вызов логируется здесь с `isError: true`.
   */
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

/** Служебные тексты, которыми закрывается ход без нормального ответа. */
export interface AgentFallbackTexts {
  /** Дописывается к обрывку при `max_tokens`. */
  truncatedNote: string;
  /** Обрыв случился до первого слова. */
  truncatedEmpty: string;
  /** Модель не сказала ничего, а причина — не `max_tokens`. */
  noAnswer: string;
}

export interface AgentProfile {
  client: AgentClient;
  model: string;
  temperature: number;
  maxTokens: number;
  /**
   * Конфиг thinking. У поддержки — `{ type: 'disabled' }`: с включённым
   * thinking DeepSeek игнорирует `temperature`, а tool-цикл обязан возвращать
   * thinking-блоки обратно. `undefined` — поле не отправляется (продажный).
   */
  thinking?: Anthropic.ThinkingConfigParam;
  /**
   * Системный текст. Строкой — для DeepSeek (форма массива блоков у него не
   * описана); массивом блоков — для Anthropic с `cache_control`.
   */
  system: string | Anthropic.TextBlockParam[];
  tools: Anthropic.ToolUnion[];
  /** Потолок итераций tool-цикла. */
  maxIterations: number;
  /**
   * Кэш-брейкпоинт на истории (Anthropic). DeepSeek `cache_control` игнорирует,
   * кэш у него автоматический — лишнее поле только раздувает запрос.
   */
  historyCaching: boolean;
  /** Ставить ли `is_error` в `tool_result`. DeepSeek это поле игнорирует. */
  toolErrorsAsIsError: boolean;
  /**
   * Сквозной потолок серверных `web_search` на один ход. `0` — серверных tools
   * у профиля нет, и `pause_turn` от провайдера продолжать нечем.
   */
  maxWebSearchPerRun: number;
  /** Хэш клиента для изоляции кэша провайдера. Никогда не telegram_id и не PII. */
  metadataUserId?: string;
  /** Исполнение tool'а. Zod-граница и диспетчеризация — внутри профиля. */
  dispatch(name: string, rawInput: unknown): Promise<ToolExecution>;
  texts: AgentFallbackTexts;
}

export interface AgentRunResult {
  text: string;
  usage: Anthropic.Usage;
  toolCalls: ToolCallLog[];
  /**
   * Модель НЕ довела ход до конца: упёрлась в `max_tokens`, отказалась или
   * вернула неизвестный `stop_reason`. Текст в этом случае частично или целиком
   * наш, служебный.
   *
   * Call-site обязан не приклеивать к такому ответу действия над заказом
   * (кнопку «Подтвердить», карточку заказа): пользователь увидел бы призыв
   * оплатить сумму, которой в сообщении нет.
   */
  incomplete: boolean;
}

/**
 * Сбой tool-цикла, НЕСУЩИЙ уже потраченный usage.
 *
 * Дневной токен-бюджет считается по тому, что вернул ход, поэтому голый `throw`
 * списывал ноль токенов за самые дорогие запросы: шесть итераций Sonnet,
 * упавших на седьмой, не стоили бюджету ничего, и защита расходов слепла ровно
 * на том, от чего защищает (аудит 2026-08-10, HIGH). Call-site обязан в `catch`
 * записать `err.usage`.
 */
export class AgentLoopError extends Error {
  /** Сумма по всем состоявшимся итерациям; `null` — не успели ни одной. */
  readonly usage: Anthropic.Usage | null;
  readonly reason: 'api_error' | 'max_iterations';
  /**
   * Tools, которые цикл УЖЕ ВЫПОЛНИЛ до сбоя.
   *
   * Не диагностика, а факты о деньгах: среди них может быть успешный
   * `propose_order` (заказ в БД) или `confirm_order` (счёт у шлюза и живая
   * платёжная ссылка). Выбросить их вместе с ошибкой значит сказать клиенту
   * «AI недоступен», пока против его заказа висит выставленный счёт.
   */
  readonly toolCalls: ToolCallLog[];

  constructor(opts: {
    message: string;
    usage: Anthropic.Usage | null;
    reason: 'api_error' | 'max_iterations';
    toolCalls: ToolCallLog[];
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AgentLoopError';
    this.usage = opts.usage;
    this.reason = opts.reason;
    this.toolCalls = opts.toolCalls;
  }
}

/** Сколько раз подряд соглашаемся продолжить приостановленный ход. */
const MAX_PAUSE_CONTINUATIONS = 3;

/** Ответ, склеенный из всех text-блоков. */
export function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Суммирование usage по итерациям tool-цикла: каждая итерация — отдельный
 * billable-вызов API, поэтому для честного учёта расходов складываем все
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
 * Второй cache-брейкпоинт — на истории диалога (первый — на system-блоке).
 * Возвращает копию `messages`, где последний content-блок последнего сообщения
 * помечен `cache_control` — кэшируется весь префикс разговора целиком.
 *
 * Брейкпоинт «едет» вперёд с каждым вызовом: предыдущие позиции Anthropic
 * находит сам (автоматический lookup по ~20 последним блокам), поэтому держим
 * ровно один маркер в messages и не упираемся в лимит 4 брейкпоинтов на запрос.
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
 * Один круг разговора с моделью по правилам профиля.
 *
 * Возвращает финальный текст, usage (просуммированный по ВСЕМ итерациям) и лог
 * вызовов tools.
 */
export async function runProfile(
  history: AgentMessage[],
  profile: AgentProfile,
): Promise<AgentRunResult> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const toolCalls: ToolCallLog[] = [];
  let totalUsage: Anthropic.Usage | null = null;
  /**
   * Текст, сказанный моделью ДО паузы хода. Без накопления он терялся: ответ
   * собирался только из последнего сообщения, и клиент получал «Итого 1 350 ₽»
   * без строки, объясняющей, откуда сумма.
   */
  const textSoFar: string[] = [];
  /** Продолжений приостановленного хода — свой бюджет, не из итераций. */
  let pauseContinuations = 0;
  /** Идёт ли сейчас продолжение приостановленного хода. */
  let continuingPausedTurn = false;
  // Сквозной потолок web_search на ОДИН ход. `max_uses` в описании tool'а —
  // это лимит на один вызов API, а цикл делает несколько итераций, поэтому без
  // этого счётчика дорогой web_search мог бы сработать вдвое чаще.
  let webSearchUsed = 0;
  const serverToolsEnabled = profile.maxWebSearchPerRun > 0;

  const finish = (text: string, incomplete: boolean): AgentRunResult => ({
    text,
    usage: totalUsage as Anthropic.Usage,
    toolCalls,
    incomplete,
  });

  for (let step = 0; step < profile.maxIterations; step++) {
    // Продолжение приостановленного хода обязано идти с тем же набором tools:
    // в истории уже лежат блоки `server_tool_use`/`web_search_tool_result`, и
    // отправить их без объявленного `web_search` — верный 400 от API.
    const toolsForStep =
      serverToolsEnabled && webSearchUsed >= profile.maxWebSearchPerRun && !continuingPausedTurn
        ? profile.tools.filter((t) => t.name !== 'web_search')
        : profile.tools;

    let response: Anthropic.Message;
    try {
      response = await profile.client.messages.create({
        model: profile.model,
        max_tokens: profile.maxTokens,
        temperature: profile.temperature,
        system: profile.system,
        tools: toolsForStep,
        messages: profile.historyCaching ? withHistoryCacheBreakpoint(messages) : messages,
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
        ...(profile.metadataUserId ? { metadata: { user_id: profile.metadataUserId } } : {}),
      });
    } catch (err) {
      // Токены предыдущих итераций уже потрачены — отдаём их наверх вместе с
      // ошибкой, иначе бюджет их не увидит никогда.
      throw new AgentLoopError({
        message: err instanceof Error ? err.message : String(err),
        usage: totalUsage,
        reason: 'api_error',
        toolCalls,
        cause: err,
      });
    }

    totalUsage = addUsage(totalUsage, response.usage);
    webSearchUsed += response.usage.server_tool_use?.web_search_requests ?? 0;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        let result: unknown;
        let isError = false;
        try {
          const execution = await profile.dispatch(tu.name, tu.input);
          result = execution.result;
          isError = execution.isError;
        } catch (err) {
          isError = true;
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        toolCalls.push({ name: tu.name, input: tu.input, output: result, isError });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          // Ошибка едет ТЕКСТОМ в теле результата всегда: у DeepSeek `is_error`
          // игнорируется, и модель узнаёт о неудаче только из содержимого.
          content: JSON.stringify(result),
          ...(isError && profile.toolErrorsAsIsError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // `pause_turn` — серверный tool просит продолжить ход, а не финал. Без
    // серверных tools продолжать нечем, и такой ответ трактуется как обычное
    // завершение (защитное правило разбора `stop_reason`).
    if (response.stop_reason === 'pause_turn' && serverToolsEnabled) {
      const said = collectText(response.content);
      if (said.trim()) textSoFar.push(said);
      messages.push({ role: 'assistant', content: response.content });
      // Паузы НЕ едят бюджет итераций: иначе разговор с несколькими поисками
      // упирался бы в потолок вместо ответа. Свой потолок нужен — без него
      // сервер мог бы паузить бесконечно.
      pauseContinuations += 1;
      if (pauseContinuations > MAX_PAUSE_CONTINUATIONS) {
        return finish(textSoFar.join('\n'), true);
      }
      step -= 1;
      continuingPausedTurn = true;
      continue;
    }
    continuingPausedTurn = false;

    const text = [...textSoFar, collectText(response.content)]
      .filter((part) => part.trim())
      .join('\n');

    // `max_tokens` — ответ ОБОРВАН. Молчать нельзя, выдавать обрывок за
    // законченную мысль — тоже.
    if (response.stop_reason === 'max_tokens') {
      return finish(
        text.trim() ? `${text}${profile.texts.truncatedNote}` : profile.texts.truncatedEmpty,
        true,
      );
    }

    // `end_turn` и всё остальное (`refusal`, `stop_sequence`, коды конкретного
    // провайдера, о которых мы ещё не знаем): важен не код, а есть ли что
    // сказать. Пустой ответ — это молчание бота, которое читается как поломка.
    return text.trim() ? finish(text, false) : finish(profile.texts.noAnswer, true);
  }

  throw new AgentLoopError({
    message: `Agent tool-use loop exceeded ${profile.maxIterations} iterations`,
    usage: totalUsage,
    reason: 'max_iterations',
    toolCalls,
  });
}
