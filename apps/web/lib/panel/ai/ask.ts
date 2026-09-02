import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import {
  AgentLoopError,
  isSupportAiConfigured,
  runProfile,
  type AgentClient,
  type AgentMessage,
} from '@oplati/agent';

import { childLogger } from '@/lib/logger';
import { checkRateLimit, type RateLimitResult } from '@/lib/ratelimit';

import { buildPanelAnalystProfile, panelAnalystModel, panelStaffHash } from './profile';
import { executeRunSql, type RunSqlOutcome, type RunSqlView } from './run-sql';

/**
 * Один вопрос аналитику панели (спека admin-panel-v2, ветка B, тикет 06).
 *
 * Чат ЭФЕМЕРНЫЙ (Q11): история живёт в клиентском компоненте и приходит с
 * каждым запросом; сервер stateless, в БД не пишется ничего — ни разговоров, ни
 * сообщений, ни `ai_usage_daily` (это глобальная строка КЛИЕНТСКОГО бюджета,
 * и расходы DeepSeek в неё не входят). Учёт — строка лога `panel.ai.usage`,
 * видна в Loki.
 *
 * Никогда не бросает: любой отказ — Result с причиной, которую роут переводит
 * в код ответа, а экран — в текст словаря.
 */

const log = childLogger('panel.ai');

/** Потолки истории: 20 ходов и 8 КБ текста — больше в один запрос не нужно. */
export const ANALYST_HISTORY_MAX_TURNS = 20;
export const ANALYST_HISTORY_MAX_BYTES = 8 * 1024;
export const ANALYST_QUESTION_MAX = 2000;

export const analystTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(ANALYST_HISTORY_MAX_BYTES),
});

export const analystHistorySchema = z
  .array(analystTurnSchema)
  .max(ANALYST_HISTORY_MAX_TURNS)
  .refine(
    (turns) => turns.reduce((sum, t) => sum + Buffer.byteLength(t.text, 'utf8'), 0) <= ANALYST_HISTORY_MAX_BYTES,
    { message: `history exceeds ${ANALYST_HISTORY_MAX_BYTES} bytes` },
  );

export type AnalystTurn = z.infer<typeof analystTurnSchema>;

export type AnalystUsage = { inputTokens: number; outputTokens: number };

export type AskAnalystResult =
  | {
      ok: true;
      answer: string;
      toolCalls: RunSqlView[];
      usage: AnalystUsage;
      /** Модель не довела ход: обрыв по лимиту токенов или пустой ответ. */
      incomplete: boolean;
    }
  | {
      ok: false;
      reason: 'not_configured' | 'invalid_history' | 'rate_limited' | 'model_failed' | 'max_iterations';
      toolCalls: RunSqlView[];
      usage: AnalystUsage | null;
    };

export type AskAnalystDeps = {
  client?: AgentClient;
  runSql?: (rawInput: unknown) => Promise<RunSqlOutcome>;
  rateLimit?: (identity: string) => Promise<RateLimitResult>;
  isConfigured?: () => boolean;
  now?: Date;
};

/**
 * Anthropic Messages требует строгого чередования ролей и первого хода от
 * пользователя. Клиентский компонент это соблюдает, но граница есть граница:
 * ведущие ответы отбрасываются, соседние одинаковые роли склеиваются (тот же
 * урок, что у `toAgentHistory` — непарная история давала 400 на каждый ход).
 */
export function normalizeAnalystHistory(turns: readonly AnalystTurn[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const turn of turns) {
    if (out.length === 0 && turn.role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${turn.text}`;
      continue;
    }
    out.push({ role: turn.role, content: turn.text });
  }
  // История обязана заканчиваться ответом: следом идёт новый вопрос.
  if (out[out.length - 1]?.role === 'user') out.pop();
  return out;
}

function usageOf(u: { input_tokens: number; output_tokens: number } | null): AnalystUsage | null {
  return u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : null;
}

export async function askAnalyst(
  input: { staffId: string; question: string; history: unknown },
  deps: AskAnalystDeps = {},
): Promise<AskAnalystResult> {
  const isConfigured = deps.isConfigured ?? isSupportAiConfigured;
  if (!isConfigured()) {
    return { ok: false, reason: 'not_configured', toolCalls: [], usage: null };
  }

  const history = analystHistorySchema.safeParse(input.history);
  if (!history.success) {
    return { ok: false, reason: 'invalid_history', toolCalls: [], usage: null };
  }

  const limit = await (deps.rateLimit ?? ((id: string) => checkRateLimit('panel-ai', id)))(
    input.staffId,
  );
  if (!limit.allowed) {
    log.warn({ event: 'panel.ai.rate_limited', staffHash: panelStaffHash(input.staffId) });
    return { ok: false, reason: 'rate_limited', toolCalls: [], usage: null };
  }

  const runSql = deps.runSql ?? executeRunSql;
  const views: RunSqlView[] = [];
  const staffHash = panelStaffHash(input.staffId);
  const startedAt = Date.now();

  const profile = buildPanelAnalystProfile({
    staffId: input.staffId,
    now: deps.now,
    ...(deps.client ? { client: deps.client } : {}),
    dispatch: async (name, rawInput) => {
      if (name !== 'run_sql') {
        return { result: { error: `unknown tool: ${name}` }, isError: true };
      }
      const sqlStartedAt = Date.now();
      const out = await runSql(rawInput);
      views.push(out.view);
      log.info({
        event: 'panel.ai.sql',
        staffHash,
        durationMs: Date.now() - sqlStartedAt,
        rows: out.view.rows.length,
        truncated: out.view.truncated,
        error: out.view.error !== null,
      });
      // Сам SQL — на уровне debug: PII в нём нет, но объём есть.
      log.debug({ event: 'panel.ai.sql_text', staffHash, sql: out.view.sql });
      return out.execution;
    },
  });

  const messages: AgentMessage[] = [
    ...normalizeAnalystHistory(history.data),
    { role: 'user', content: input.question },
  ];

  const finishLog = (outcome: string, usage: AnalystUsage | null) => {
    log.info({
      event: 'panel.ai.usage',
      staffHash,
      model: panelAnalystModel(),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      toolCalls: views.length,
      durationMs: Date.now() - startedAt,
      outcome,
    });
  };

  try {
    const result = await runProfile(messages, profile);
    const usage = usageOf(result.usage) ?? { inputTokens: 0, outputTokens: 0 };
    finishLog(result.incomplete ? 'incomplete' : 'ok', usage);
    return { ok: true, answer: result.text, toolCalls: views, usage, incomplete: result.incomplete };
  } catch (err) {
    if (err instanceof AgentLoopError) {
      const usage = usageOf(err.usage);
      finishLog(err.reason, usage);
      if (err.reason === 'max_iterations') {
        log.warn({ event: 'panel.ai.max_iterations', staffHash, toolCalls: views.length });
        return { ok: false, reason: 'max_iterations', toolCalls: views, usage };
      }
      // Сбой провайдера — неожиданный отказ: его надо видеть.
      log.error({ event: 'panel.ai.model_failed', staffHash, err });
      Sentry.captureException(err, { tags: { source: 'panel.ai' } });
      return { ok: false, reason: 'model_failed', toolCalls: views, usage };
    }
    finishLog('error', null);
    log.error({ event: 'panel.ai.failed', staffHash, err });
    Sentry.captureException(err, { tags: { source: 'panel.ai' } });
    return { ok: false, reason: 'model_failed', toolCalls: views, usage: null };
  }
}
