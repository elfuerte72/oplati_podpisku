import 'server-only';

import { createHash } from 'node:crypto';

import { getSupportClient, supportModel, type AgentClient, type AgentProfile } from '@oplati/agent';

import { runSqlTool } from './run-sql';
import { buildPanelAnalystSystemPrompt } from './system-prompt';

/**
 * Профиль движка для AI-аналитика панели (спека admin-panel-v2, ветка B,
 * тикет 06) — по образцу `lib/support/profile.ts`: тот же DeepSeek через
 * Anthropic-совместимый endpoint и тот же `runProfile`.
 *
 * Отличия от помощника поддержки продиктованы задачей, а не вкусом:
 *   - восемь итераций вместо четырёх — аналитик ходит в базу несколько раз
 *     (ошибка SQL → правка → уточнение), и цепочка из трёх запросов штатна;
 *   - `maxTokens` 2000 — ответ с таблицей длиннее реплики поддержки;
 *   - `toolErrorsAsIsError: true` — ошибка SQL обязана вернуться модели как
 *     ошибка инструмента, а не прервать цикл; текст ошибки едет и в теле;
 *   - температура ниже: аналитик считает, а не сочиняет.
 *
 * Расходы DeepSeek в клиентский дневной бюджет не входят (как у поддержки).
 */

const ANALYST_TEMPERATURE = 0.1;
const ANALYST_MAX_TOKENS = 2000;
export const ANALYST_MAX_ITERATIONS = 8;

/** Модель аналитика: `PANEL_AI_MODEL`, иначе модель помощника поддержки. */
export function panelAnalystModel(): string {
  // `||`, а не `??`: `KEY=` в env — это «не задано».
  return process.env.PANEL_AI_MODEL || supportModel();
}

/**
 * Идентификатор для провайдера — хэш `staff.id`, не сам id и не telegram_id:
 * провайдеру нужна изоляция кэша между сотрудниками и ничего больше.
 */
export function panelStaffHash(staffId: string): string {
  return createHash('sha256').update(`panel-ai:${staffId}`).digest('hex').slice(0, 32);
}

/** Сегодняшняя дата для промпта — `YYYY-MM-DD` по UTC. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function buildPanelAnalystProfile(input: {
  staffId: string;
  dispatch: AgentProfile['dispatch'];
  /** Подмена клиента — тесты через шов `AgentClient`. */
  client?: AgentClient;
  now?: Date;
}): AgentProfile {
  return {
    client: input.client ?? getSupportClient(),
    model: panelAnalystModel(),
    temperature: ANALYST_TEMPERATURE,
    maxTokens: ANALYST_MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: buildPanelAnalystSystemPrompt({ today: todayUtc(input.now) }),
    tools: [runSqlTool],
    maxIterations: ANALYST_MAX_ITERATIONS,
    historyCaching: false,
    toolErrorsAsIsError: true,
    maxWebSearchPerRun: 0,
    metadataUserId: panelStaffHash(input.staffId),
    dispatch: input.dispatch,
    texts: ANALYST_FALLBACK_TEXTS,
  };
}

/** Служебные тексты хода — безличные, как всё в панели. */
export const ANALYST_FALLBACK_TEXTS = {
  truncatedNote:
    '\n\n(Ответ получился длинным и оборвался. Уточните вопрос — например, сузьте период или число строк.)',
  truncatedEmpty:
    'Ответ не поместился в лимит. Сформулируйте вопрос уже — по одному показателю или за меньший период.',
  noAnswer: 'Модель не вернула ответ. Повторите вопрос или переформулируйте его.',
};
