import 'server-only';

import { createHash } from 'node:crypto';

import {
  buildSupportSystemPrompt,
  getSupportClient,
  supportModel,
  type AgentProfile,
} from '@oplati/agent';

import { collectSupportFacts } from './facts';

/**
 * Профиль движка для помощника поддержки (спека §4).
 *
 * Отличия от продажного профиля — не прихоть, а факты о провайдере:
 *   - `thinking: disabled` — с включённым thinking DeepSeek игнорирует
 *     `temperature`, а tool-цикл обязан возвращать thinking-блоки обратно;
 *   - `system` строкой — форма массива блоков у него не описана, а выдумывать
 *     контракт внешнего API нельзя;
 *   - без `cache_control` — он игнорируется, кэш автоматический;
 *   - без `is_error` в `tool_result` — тоже игнорируется, поэтому ошибка едет
 *     текстом в теле результата;
 *   - четыре итерации вместо шести — у поддержки нет серверного поиска, и
 *     длинная цепочка означала бы, что модель ходит по кругу.
 */

/** Температура: поддержка отвечает фактами, а не сочиняет. */
const SUPPORT_TEMPERATURE = 0.2;

/** Потолок ответа: два-три предложения решают вопрос поддержки. */
const SUPPORT_MAX_TOKENS = 600;

/** Потолок итераций tool-цикла. */
const SUPPORT_MAX_ITERATIONS = 4;

/**
 * Идентификатор клиента для провайдера — ХЭШ внутреннего `users.id`.
 *
 * Не `telegram_id`: он публичен и связывает переписку с конкретным человеком.
 * Не сырой `users.id`: это тоже идентификатор в нашей системе. Хэш даёт
 * провайдеру изоляцию кэша между клиентами и ничего больше.
 */
export function supportUserHash(userId: string): string {
  return createHash('sha256').update(`support:${userId}`).digest('hex').slice(0, 32);
}

export function buildSupportProfile(input: {
  userId: string;
  /** Инструменты помощника. Пусто — помощник отвечает только из базы знаний. */
  tools?: AgentProfile['tools'];
  dispatch?: AgentProfile['dispatch'];
}): AgentProfile {
  return {
    client: getSupportClient(),
    model: supportModel(),
    temperature: SUPPORT_TEMPERATURE,
    maxTokens: SUPPORT_MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: buildSupportSystemPrompt(collectSupportFacts()),
    tools: input.tools ?? [],
    maxIterations: SUPPORT_MAX_ITERATIONS,
    historyCaching: false,
    toolErrorsAsIsError: false,
    maxWebSearchPerRun: 0,
    metadataUserId: supportUserHash(input.userId),
    dispatch:
      input.dispatch ??
      (async (name) => ({ result: { error: `unknown tool: ${name}` }, isError: true })),
    texts: SUPPORT_FALLBACK_TEXTS,
  };
}

/**
 * Служебные тексты хода — на «вы», как и всё остальное у помощника.
 * Копия продажных здесь была бы «ты» посреди делового разговора.
 */
const SUPPORT_FALLBACK_TEXTS = {
  truncatedNote:
    '\n\n(Ответ получился длинным и оборвался. Спросите про нужную часть — договорю.)',
  truncatedEmpty:
    'Ответ получился слишком длинным и не поместился. Задайте вопрос поконкретнее — отвечу коротко.',
  // ⚠️ Пустая строка НЕ подставляется: модуль поддержки трактует пустой ответ
  // как «сказать нечего» и передаёт клиента человеку. Текст здесь нужен только
  // потому, что движок требует его в профиле, и до клиента он не доходит.
  noAnswer: '',
};
