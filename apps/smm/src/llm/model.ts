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
      options?: { timeout?: number },
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

/** Клиент провайдера. Ретрай один: ход стоит денег, а бот попросит повтор кнопкой. */
export function createModelClient(env: SmmEnv): Anthropic {
  return new Anthropic({
    apiKey: env.model.apiKey,
    baseURL: env.model.baseUrl,
    // Сроки задаются на каждый запрос ролью; здесь потолок на случай, если
    // роль его не назвала.
    timeout: 120_000,
    maxRetries: 1,
  });
}

/**
 * Вырезает ограждения кода и берёт первый объект или массив JSON.
 *
 * Модель просят отвечать чистым JSON, но она периодически оборачивает ответ в
 * ```json. Отдельная функция, потому что это единственное место, где мы
 * прощаем провайдеру отклонение от просьбы.
 */
export function extractJson(raw: string): string | undefined {
  const withoutFences = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const candidates = [withoutFences, raw];
  for (const text of candidates) {
    const firstObject = text.indexOf('{');
    const firstArray = text.indexOf('[');
    const start =
      firstObject === -1
        ? firstArray
        : firstArray === -1
          ? firstObject
          : Math.min(firstObject, firstArray);
    if (start === -1) continue;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end <= start) continue;
    return text.slice(start, end + 1);
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

export function createModel(deps: ModelDeps): Model {
  const config = deps.config ?? smmConfig;
  const promptSet = deps.promptSet ?? defaultPrompts();
  const now = deps.now ?? ((): Date => new Date());

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
    const price = modelPriceUsd(model, at);
    const inputTokens = message.usage.input_tokens ?? 0;
    const outputTokens = message.usage.output_tokens ?? 0;
    const cacheHitTokens = message.usage.cache_read_input_tokens ?? 0;
    const usdMicros = Math.round(
      inputTokens * price.inputPerMillion +
        outputTokens * price.outputPerMillion +
        cacheHitTokens * price.cacheHitPerMillion,
    );
    deps.usage.add({
      postId: ctx?.postId,
      role,
      model,
      inputTokens,
      outputTokens,
      cacheHitTokens,
      usdMicros,
      isPeak: price.isPeak,
      priceKnown: price.known,
    });
    deps.logger.info(
      {
        role,
        model,
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
        { timeout: roleConfig.timeoutMs },
      );
    } catch (error) {
      // Сеть и 5xx — это `api_error`: шаг провалился, но пост жив, и владелец
      // получит кнопку «Повторить». Исключение наружу не летит никогда.
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ role, model, postId: ctx?.postId, err: error }, 'модель не ответила');
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
