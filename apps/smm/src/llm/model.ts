import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';

import type { SmmEnv } from '../config/env.ts';
import { modelPriceUsd, smmConfig, type ModelRole, type SmmConfig } from '../config/smm.config.ts';
import type { Logger } from '../logger.ts';
import type { UsageRepo } from '../store/repos.ts';
import { prompts as defaultPrompts, type PromptSet } from './prompts.ts';

/**
 * Один вызов модели — один запрос без инструментов и без стриминга. Модель
 * пишет и оценивает, но никогда не решает, что делать дальше: следующий шаг
 * выбирает конечный автомат диалога, а не её ответ.
 *
 * Оговорки провайдера (DeepSeek через Anthropic-совместимый endpoint) сняты с
 * его же документации и повторяют боевой профиль помощника поддержки:
 *   - `thinking: disabled` — с включённым thinking игнорируется `temperature`;
 *   - `system` строкой — форма массива блоков у него не описана;
 *   - без `cache_control` — игнорируется, кэш автоматический;
 *   - без `tools` и без `metadata` — здесь они не нужны вовсе.
 */

/** Минимальный контракт клиента: тест подменяет его целиком, без сети. */
export interface MessagesClient {
  readonly messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

export type ModelFailureReason = 'invalid_json' | 'api_error' | 'empty' | 'truncated';

export type ModelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ModelFailureReason; readonly message: string };

export interface CallContext {
  /** К какому посту отнести расход. Ранжирование идей идёт без поста. */
  readonly postId?: string;
}

export interface Model {
  json<T>(
    role: ModelRole,
    input: string,
    schema: ZodType<T>,
    ctx?: CallContext,
  ): Promise<ModelResult<T>>;
  markdown(role: ModelRole, input: string, ctx?: CallContext): Promise<ModelResult<string>>;
}

export interface ModelDeps {
  readonly client: MessagesClient;
  readonly env: SmmEnv;
  readonly usage: UsageRepo;
  readonly logger: Logger;
  readonly config?: SmmConfig;
  readonly promptSet?: PromptSet;
  readonly now?: () => Date;
}

/**
 * Клиент провайдера.
 *
 * `maxRetries: 0` — повтор у нас СВОЙ, на уровне шага (один перезапрос при
 * ответе не по схеме) и кнопки «Повторить» у владельца. Ретраи SDK множились
 * бы на срок роли: при двух заходах по две минуты один шаг ждал бы восемь,
 * а в `usage` эти попытки не попадают вовсе.
 */
export function createModelClient(env: SmmEnv): Anthropic {
  return new Anthropic({
    apiKey: env.model.apiKey,
    baseURL: env.model.baseUrl,
    // Сроки задаются на каждый запрос ролью; здесь потолок на случай, если
    // роль его не назвала.
    timeout: 120_000,
    maxRetries: 0,
  });
}

/**
 * Достаёт JSON из ответа модели.
 *
 * Модель просят отвечать чистым JSON, но она периодически оборачивает ответ в
 * ограждения кода и дописывает фразу вокруг. Наивное «от первой скобки до
 * последней» теряло валидный ответ, если в прозе была любая фигурная скобка
 * («в поле {link}», «формат {ключ: значение}»), — а такая привычка у модели
 * частая, и шаг проваливался при готовом JSON в руках (ревью тикета 03).
 * Поэтому ищется СБАЛАНСИРОВАННЫЙ фрагмент, который разбирается.
 */
export function extractJson(raw: string): string | undefined {
  const text = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  for (let start = 0; start < text.length; start += 1) {
    const char = text[start];
    if (char !== '{' && char !== '[') continue;
    const end = matchingBracket(text, start);
    if (end === undefined) continue;
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Сбалансированный, но не разобравшийся фрагмент — это проза со
      // скобками. Ищем дальше, а не сдаёмся на первом кандидате.
      continue;
    }
  }
  return undefined;
}

/** Индекс закрывающей скобки для открывающей на `start`, с учётом строк JSON. */
function matchingBracket(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if (open === undefined) return undefined;
      if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) return undefined;
      if (stack.length === 0) return i;
    }
  }
  return undefined;
}

/** Разбор ответа по схеме: одна точка, чтобы текст ошибки для повтора был один. */
function parseAgainstSchema<T>(
  raw: string,
  schema: ZodType<T>,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string } {
  const extracted = extractJson(raw);
  if (extracted === undefined) return { ok: false, problem: 'в ответе нет JSON' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (error) {
    return {
      ok: false,
      problem: `JSON не разобрался: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const checked = schema.safeParse(parsed);
  if (checked.success) return { ok: true, value: checked.data };
  return {
    ok: false,
    problem: checked.error.issues
      .map((issue) => `${issue.path.join('.') || 'ответ'}: ${issue.message}`)
      .join('; '),
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function modelNameFor(role: ModelRole, env: SmmEnv, config: SmmConfig): string {
  const source = config.roles[role].model;
  if (source === 'judge') return env.model.judge;
  if (source === 'rank') return env.model.rank;
  return env.model.writer;
}

/** Отрицательные и нечисловые значения от провайдера занижали бы месячную сводку. */
function nonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function createModel(deps: ModelDeps): Model {
  const config = deps.config ?? smmConfig;
  const promptSet = deps.promptSet ?? defaultPrompts();
  const now = deps.now ?? ((): Date => new Date());
  /** Предупреждение о подмене модели — один раз на процесс, а не на каждый вызов. */
  const warnedMismatch = new Set<string>();

  /**
   * Учёт расхода. Микродоллары считаются красиво: $1 за миллион токенов — это
   * ровно один микродоллар за токен, поэтому `tokens * pricePerMillion` уже
   * даёт микродоллары без делений и без float-накопления.
   *
   * Пишется на КАЖДЫЙ ответ, включая тот, который не разобрался: токены за него
   * провайдер уже взял, и молчать об этом — значит занижать месячный счёт.
   */
  function recordUsage(role: ModelRole, model: string, message: Anthropic.Message, ctx?: CallContext): void {
    const at = now();
    // Имя модели берётся из ОТВЕТА: провайдер молча маппит незнакомый id на
    // свою модель, и опечатка в env иначе выглядит рабочей настройкой (те же
    // грабли описаны у боевого клиента помощника).
    const answered = typeof message.model === 'string' && message.model !== '' ? message.model : model;
    if (answered !== model && !warnedMismatch.has(model)) {
      warnedMismatch.add(model);
      deps.logger.warn({ requested: model, answered }, 'провайдер ответил другой моделью');
    }
    const price = modelPriceUsd(answered, at);
    // Поле usage может не прийти вовсе: его маппинг в Anthropic-совместимом
    // слое DeepSeek не документирован, а «дока провайдера врёт» — правило дома.
    const usage = (message.usage ?? {}) as Partial<Anthropic.Usage>;
    const inputTokens = nonNegative(usage.input_tokens);
    const outputTokens = nonNegative(usage.output_tokens);
    // ⚠️ Семантика кэша живым вызовом НЕ подтверждена: считаем, что
    // `input_tokens` кэш-попадания не включает (как у Anthropic). Если слой
    // DeepSeek отдаёт сумму, кэш посчитается дважды — сырые поля печатает
    // `eval:llm`, один живой прогон закрывает вопрос.
    const cacheHitTokens = nonNegative(usage.cache_read_input_tokens);
    const usdMicros = Math.round(
      inputTokens * price.inputPerMillion +
        outputTokens * price.outputPerMillion +
        cacheHitTokens * price.cacheHitPerMillion,
    );
    try {
      deps.usage.add({
        postId: ctx?.postId,
        role,
        model: answered,
        inputTokens,
        outputTokens,
        cacheHitTokens,
        usdMicros,
        isPeak: price.isPeak,
        priceKnown: price.known,
      });
    } catch (error) {
      // Потеря строки учёта дешевле потери поста: ответ уже оплачен, и шаг
      // обязан продолжиться. Обещание «json и markdown не бросают» держится
      // именно здесь.
      deps.logger.error({ role, model: answered, err: error }, 'расход не записался');
    }
    deps.logger.info(
      {
        role,
        model: answered,
        postId: ctx?.postId,
        inputTokens,
        outputTokens,
        cacheHitTokens,
        usdMicros,
        isPeak: price.isPeak,
        stopReason: message.stop_reason,
      },
      'вызов модели',
    );
  }

  async function call(
    role: ModelRole,
    messages: Anthropic.MessageParam[],
    ctx?: CallContext,
  ): Promise<
    | { readonly ok: true; readonly message: Anthropic.Message; readonly text: string }
    | { readonly ok: false; readonly reason: ModelFailureReason; readonly message: string }
  > {
    const roleConfig = config.roles[role];
    const model = modelNameFor(role, deps.env, config);
    let response: Anthropic.Message;
    try {
      response = await deps.client.messages.create(
        {
          model,
          max_tokens: roleConfig.maxTokens,
          temperature: roleConfig.temperature,
          system: promptSet[role],
          messages,
          thinking: { type: 'disabled' },
        },
        {
          timeout: roleConfig.timeoutMs,
          // ⚠️ Одного `timeout` недостаточно: SDK снимает таймер сразу после
          // получения ЗАГОЛОВКОВ, и провайдер, отдавший 200 и замолчавший на
          // теле, вешает шаг навсегда (правило CLAUDE.md про чтение тела,
          // аудит 2026-08-10). `signal` живёт до конца чтения.
          signal: AbortSignal.timeout(roleConfig.timeoutMs),
        },
      );
    } catch (error) {
      // Сеть, 5xx и обрыв на чтении тела — это `api_error`: шаг провалился, но
      // пост жив, и владелец получит кнопку «Повторить». Исключение наружу не
      // летит никогда.
      const message = error instanceof Error ? error.message : String(error);
      // Ошибку логируем ПО ЧАСТЯМ: у APIError в `message` лежит тело ответа
      // провайдера, а в нём при 400 может оказаться фрагмент запроса — то есть
      // текст поста, который в лог не ходит.
      deps.logger.warn(
        {
          role,
          model,
          postId: ctx?.postId,
          status: (error as { status?: number }).status,
          requestId: (error as { request_id?: string }).request_id,
          reason: message.slice(0, 200),
        },
        'модель не ответила',
      );
      return { ok: false, reason: 'api_error', message };
    }

    recordUsage(role, model, response, ctx);
    const text = textOf(response);
    if (response.stop_reason === 'max_tokens') {
      // Ответ ОБОРВАН. Выдавать обрывок за готовый текст нельзя: у JSON он не
      // разберётся, а у поста это половина мысли.
      return { ok: false, reason: 'truncated', message: 'ответ модели оборвался на лимите токенов' };
    }
    if (text === '') {
      return { ok: false, reason: 'empty', message: `модель ответила пусто (${response.stop_reason ?? 'без причины'})` };
    }
    return { ok: true, message: response, text };
  }

  return {
    async json(role, input, schema, ctx) {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input }];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await call(role, messages, ctx);
        if (!answer.ok) {
          // Оборвавшийся ответ повторять смысла нет: тот же запрос даст тот же
          // обрыв. Сеть тоже не повторяем — за ретраи отвечает клиент SDK.
          return { ok: false, reason: answer.reason, message: answer.message };
        }

        const checked = parseAgainstSchema(answer.text, schema);
        if (checked.ok) return { ok: true, value: checked.value };
        const problem = checked.problem;

        if (attempt === 1) {
          deps.logger.warn({ role, postId: ctx?.postId, problem }, 'ответ модели не по схеме дважды');
          return { ok: false, reason: 'invalid_json', message: problem };
        }

        // ОДИН повтор с текстом ошибки схемы: модель видит, что именно не
        // подошло, и это дешевле, чем провалить шаг.
        messages.push(
          { role: 'assistant', content: answer.text.slice(0, 2000) },
          {
            role: 'user',
            content:
              `Ответ не подошёл: ${problem}. Повтори тот же ответ целиком, ` +
              'строго одним объектом JSON по схеме, без пояснений и без ограждений кода.',
          },
        );
      }

      return { ok: false, reason: 'invalid_json', message: 'ответ не по схеме' };
    },

    async markdown(role, input, ctx) {
      const answer = await call(role, [{ role: 'user', content: input }], ctx);
      if (!answer.ok) return { ok: false, reason: answer.reason, message: answer.message };
      return { ok: true, value: answer.text };
    },
  };
}
