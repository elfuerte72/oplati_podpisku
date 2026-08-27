import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { InlineKeyboard } from 'grammy';

import {
  appendMessage,
  countSupportAiReplies,
  getConversationState,
  getDb,
  loadSupportHistory,
  touchConversationMode,
  transitionConversationMode,
} from '@oplati/db';
import { isSupportAiConfigured, runProfile } from '@oplati/agent';

import { trackServer } from '@/lib/analytics/track';
import { childLogger } from '@/lib/logger';

import { sendSafely, withTypingIndicator } from '../telegram/send';
import { buildSupportOperatorMessage } from '../telegram/templates';
import { sendToSupportOperator } from '../telegram/support';
import type {
  SupportAnalyticsPort,
  SupportDeliveryPort,
  SupportModelPort,
  SupportPorts,
  SupportStaffPort,
  SupportStatePort,
} from './ports';
import { buildSupportProfile } from './profile';
import { SUPPORT_FINISH_BUTTON, SUPPORT_FINISH_CALLBACK } from './texts';

/**
 * Боевые реализации портов модуля поддержки.
 *
 * Здесь и только здесь модуль встречается с БД, grammY, провайдером модели и
 * аналитикой. Тесты матрицы поведения этот файл не трогают — они работают
 * через порты, а он проверяется тем же способом, что и остальной бот.
 */

const log = childLogger('support');
const dbLog = childLogger('db');

/** Взведён ли уже алёрт о пропавшем ключе — один раз на процесс. */
let missingKeyAlerted = false;

export type SupportRequestContext = {
  conversationId: string;
  userId: string;
  chatId: number;
  telegramId: number;
  updateId: number;
  /** Имя клиента для сообщения оператору. Модели НЕ передаётся. */
  displayName?: string | null;
  username?: string | null;
};

function keyboardWithFinish(): InlineKeyboard {
  return new InlineKeyboard().text(SUPPORT_FINISH_BUTTON, SUPPORT_FINISH_CALLBACK);
}

function stateAdapter(ctx: SupportRequestContext): SupportStatePort {
  return {
    read: async () => {
      try {
        const state = await getConversationState(getDb(), ctx.conversationId);
        if (!state) return null;
        return {
          mode: state.mode,
          modeExpiresAt: state.modeExpiresAt,
          assignedOperatorId: state.assignedOperatorId,
        };
      } catch (err) {
        // ⚠️ Наружу `null`, а не исключение: недоступная БД означает «состояние
        // прочитать нечем», и модуль уводит клиента в сегодняшний флоу к
        // человеку. Падение здесь роняло бы весь webhook.
        log.error({ event: 'support.state.read_failed', conversationId: ctx.conversationId, err });
        Sentry.captureException(err, { tags: { source: 'support.state' } });
        return null;
      }
    },
    transition: async (input) => {
      const res = await transitionConversationMode(
        getDb(),
        { conversationId: ctx.conversationId, ...input },
        dbLog,
      );
      return { transitioned: res.transitioned };
    },
    touch: async (mode, modeExpiresAt) => {
      await touchConversationMode(getDb(), {
        conversationId: ctx.conversationId,
        mode,
        modeExpiresAt,
      });
    },
    countAiReplies: async (since) =>
      await countSupportAiReplies(getDb(), { userId: ctx.userId, since }),
    history: async (limit) => {
      try {
        return await loadSupportHistory(getDb(), { conversationId: ctx.conversationId, limit });
      } catch (err) {
        // Ход пойдёт БЕЗ контекста, но пойдёт. Отказ обязан быть виден: молча
        // отвечающий без истории помощник выглядит просто поглупевшим.
        log.error({ event: 'support.history.load_failed', conversationId: ctx.conversationId, err });
        Sentry.captureException(err, { tags: { source: 'support.history' } });
        return [];
      }
    },
    append: async (row) => {
      await appendMessage(
        getDb(),
        {
          conversationId: ctx.conversationId,
          role: row.role,
          content: row.content,
          meta: row.meta ?? null,
        },
        dbLog,
      );
    },
  };
}

function modelAdapter(ctx: SupportRequestContext): SupportModelPort {
  return {
    configured: () => {
      const ok = isSupportAiConfigured();
      if (!ok && !missingKeyAlerted) {
        // Алёрт, а не только лог: при включённом флаге и пустом ключе помощник
        // ведёт себя как выключённый — клиент этого не замечает, и конфиг мог
        // бы протухать месяцами (паттерн `ANTHROPIC_API_KEY`).
        missingKeyAlerted = true;
        log.error({ event: 'support.ai_disabled', reason: 'no_support_key' });
        Sentry.captureMessage('SUPPORT_AI_ENABLED включён, но SUPPORT_AI_API_KEY не задан', {
          level: 'error',
          tags: { source: 'support' },
        });
      }
      return ok;
    },
    reply: async (history) => {
      const startedAt = Date.now();
      const profile = buildSupportProfile({ userId: ctx.userId });
      let result;
      try {
        // «Печатает…» — существующая обёртка бота: ход синхронный и заметно
        // дольше кнопки, а молчащий чат читается как поломка.
        result = await withTypingIndicator(ctx.chatId, () => runProfile(history, profile));
      } catch (err) {
        // ⚠️ Единственное место, где эта ошибка вообще видна. Модуль получит
        // `null` и передаст клиента человеку — молча для него, но НЕ молча для
        // нас: час пятисоток у провайдера иначе выглядел бы как «все клиенты
        // почему-то попросили оператора».
        log.error({
          event: 'support.ai_failed',
          conversationId: ctx.conversationId,
          model: profile.model,
          durationMs: Date.now() - startedAt,
          message: err instanceof Error ? err.message : String(err),
        });
        Sentry.captureException(err, { tags: { source: 'support.model' } });
        return null;
      }
      // ⚠️ В логе НЕТ текста клиента и НЕТ ответа — только факты о ходе.
      log.info({
        event: 'support.ai_reply',
        conversationId: ctx.conversationId,
        model: profile.model,
        toolCalls: result.toolCalls.length,
        incomplete: result.incomplete,
        // Сырой usage провайдера: в дневной бюджет Anthropic он не попадает
        // (другой прайс), и единственный способ увидеть расход — лог.
        usage: result.usage,
        durationMs: Date.now() - startedAt,
      });
      return {
        text: result.text,
        model: profile.model,
        usage: result.usage,
        toolsUsed: result.toolCalls.map((c) => c.name),
        incomplete: result.incomplete,
      };
    },
  };
}

function deliveryAdapter(ctx: SupportRequestContext): SupportDeliveryPort {
  return {
    toClient: async (text, opts) =>
      await sendSafely(
        ctx.chatId,
        text,
        ctx.updateId,
        opts?.withFinishButton ? keyboardWithFinish() : undefined,
      ),
  };
}

function staffAdapter(ctx: SupportRequestContext): SupportStaffPort {
  return {
    notifyEscalation: async (input) => {
      // Последние реплики клиента — контекст оператору. Ответы помощника не
      // берём: оператор откроет ленту в панели, а в личку важно donести, ЧТО
      // спрашивал человек.
      const description = input.lastMessages
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => m.content)
        .join('\n');

      const message = buildSupportOperatorMessage({
        telegramId: ctx.telegramId,
        firstName: ctx.displayName ?? undefined,
        username: ctx.username ?? undefined,
        description:
          `[помощник передал оператору: ${input.trigger}` +
          `${input.reason ? `, ${input.reason}` : ''}]\n${description || '(без текста)'}`,
      });
      return await sendToSupportOperator(message, { updateId: ctx.updateId });
    },
  };
}

function analyticsAdapter(ctx: SupportRequestContext): SupportAnalyticsPort {
  return {
    track: (event) => {
      const telegramId = String(ctx.telegramId);
      const base = { telegramId, eventKey: `tg-${ctx.updateId}-${telegramId}-${event.name}` };
      // ⚠️ Текста переписки в аналитике нет и быть не должно — только факты.
      switch (event.name) {
        case 'support_session_started':
          trackServer({ ...base, name: event.name, props: { surface: event.surface } });
          return;
        case 'support_ai_reply':
          trackServer({
            ...base,
            name: event.name,
            props: { count: event.toolsUsed, gate: event.guarded ? 'guarded' : 'clean' },
          });
          return;
        case 'support_escalated':
          trackServer({ ...base, name: event.name, props: { stage: event.trigger } });
          return;
        case 'support_session_closed':
          trackServer({ ...base, name: event.name, props: { stage: event.reason } });
          return;
      }
    },
  };
}

/** Собрать порты под конкретное входящее. */
export function supportPorts(ctx: SupportRequestContext): SupportPorts {
  return {
    state: stateAdapter(ctx),
    model: modelAdapter(ctx),
    delivery: deliveryAdapter(ctx),
    staff: staffAdapter(ctx),
    analytics: analyticsAdapter(ctx),
  };
}
