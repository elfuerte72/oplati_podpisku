import { SUPPORT_AI_META_SOURCE, type SupportEscalationTrigger } from '@oplati/types';

import { toAgentHistory } from '../chat/history';

import { maskForModel } from './mask';
import type {
  ConversationSnapshot,
  SupportCloseReason,
  SupportPorts,
  SupportSurface,
} from './ports';
import {
  aiUnavailableText,
  escalationText,
  SUPPORT_CAP_REACHED,
  SUPPORT_CLOSED_BY_CLIENT,
  SUPPORT_GREETING,
  SUPPORT_MEDIA_TO_AI,
  SUPPORT_MEDIA_TO_OPERATOR,
} from './texts';

/**
 * Модуль поддержки: единственная точка обработки хода помощника (спека §3).
 *
 * Один путь «входящее → прочитать режим → маскирование → модель → записать →
 * ответить» вместо третьей копии оркестрации AI-хода рядом с `agent-dialog` и
 * веб-чатом. Политика (кап, TTL, деградация, эскалация) правится здесь и
 * только здесь.
 *
 * Про внешний мир модуль не знает ничего — всё приходит портами (`ports.ts`).
 */

/** Сколько живёт сессия помощника без единого сообщения. */
export const SESSION_TTL_MINUTES = 30;

/** Сколько ждём клиента после ответа оператора, прежде чем закрыть разговор. */
export const OPERATOR_TTL_HOURS = 24;

/**
 * Потолок ответов помощника на клиента за скользящие сутки.
 *
 * Считается по БД, а не по Redis: у счётчика в Redis есть fail-open, и при
 * недоступном кэше один спамер крутил бы платную модель без предела.
 */
export const DAILY_AI_REPLY_CAP = 100;

/** Сколько строк переписки подаём модели. */
export const HISTORY_LIMIT = 20;

/** Префикс, которым реплики живого оператора помечаются для модели. */
export const OPERATOR_HISTORY_PREFIX = 'Оператор: ';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Чем кончилась попытка открыть сессию. Вызывающему нужен не булев флаг, а
 * ПРИЧИНА: на «уже открыта» бот отвечает короткой репликой, на «состояние не
 * прочитать» — уходит в сегодняшний флоу к человеку, и молчания не остаётся
 * ни в одном из случаев.
 */
export type OpenSupportResult =
  | { status: 'opened' }
  | { status: 'already_open' }
  | { status: 'operator_leads' }
  | { status: 'unavailable' };

export type SupportOutcome =
  /** Помощник ответил. */
  | { status: 'answered' }
  /** Разговор ушёл человеку. */
  | { status: 'escalated'; trigger: SupportEscalationTrigger }
  /** Суточный лимит исчерпан, сессия закрыта. */
  | { status: 'capped' }
  /** Медиа: помощник честно сказал, что читает только текст. */
  | { status: 'media_rejected' }
  /**
   * Сессии нет (никогда не было или погасла по сроку). Бот показывает
   * подсказку с кнопкой «Поддержка» — правило В3: обращение создаёт только
   * нажатие, а не факт того, что человек что-то написал.
   */
  | { status: 'not_in_session' }
  /** Разговор ведёт человек — помощник молчит, чтобы не спорить с оператором. */
  | { status: 'operator_leads' }
  /** Состояние прочитать не удалось: БД недоступна. */
  | { status: 'state_unavailable' };

function sessionDeadline(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MINUTES * MINUTE_MS);
}

export function operatorDeadline(now: Date): Date {
  return new Date(now.getTime() + OPERATOR_TTL_HOURS * HOUR_MS);
}

/**
 * Эффективный режим с учётом ЛЕНИВОГО истечения срока.
 *
 * Срок не гасится по таймеру — его замечает следующее входящее. Отдельный
 * сторож ради тишины в чате не нужен: клиент, которому сессия истекла молча,
 * не должен получать «ваша сессия закрыта» через полчаса после того, как ушёл.
 */
export function effectiveMode(
  snapshot: ConversationSnapshot,
  now: Date,
): { mode: ConversationSnapshot['mode']; expired: boolean } {
  const expired =
    snapshot.mode === 'ai' &&
    snapshot.modeExpiresAt !== null &&
    snapshot.modeExpiresAt.getTime() <= now.getTime();
  return { mode: expired ? 'idle' : snapshot.mode, expired };
}

/**
 * Открыть сессию помощника — единственный вход (правило В3: кнопка,
 * `/support`, deep-link).
 *
 * Повторное нажатие в живой сессии приветствие НЕ повторяет: кнопка «Поддержка»
 * живёт в стартовом меню, по ней жмут от растерянности, и три приветствия
 * подряд выглядят поломкой.
 */
export async function openSupportSession(
  ports: SupportPorts,
  opts: { surface: SupportSurface; now?: Date },
): Promise<OpenSupportResult> {
  const now = opts.now ?? new Date();
  const snapshot = await ports.state.read();
  if (!snapshot) return { status: 'unavailable' };

  const { mode, expired } = effectiveMode(snapshot, now);

  if (mode === 'operator') {
    // Разговор у человека — молча ничего не делаем: перевод обратно в
    // помощника отменил бы решение оператора, а второе приветствие поверх
    // живой переписки с человеком читается как сбой.
    return { status: 'operator_leads' };
  }

  if (mode === 'ai') {
    // Сессия уже открыта: продлеваем срок и НЕ повторяем приветствие.
    await ports.state.touch('ai', sessionDeadline(now));
    return { status: 'already_open' };
  }

  // ⚠️ `from` включает `ai`, а не только `idle`. У ИСТЁКШЕЙ сессии в БД
  // по-прежнему записано `ai` — срок гаснет лениво, отдельного сторожа нет.
  // Условие `from: 'idle'` не совпало бы ни с одной строкой, переход молча не
  // состоялся бы, и первое нажатие «Поддержка» после получаса тишины не
  // отвечало бы НИЧЕГО.
  const { transitioned } = await ports.state.transition({
    from: expired ? ['idle', 'ai'] : 'idle',
    to: 'ai',
    trigger: opts.surface,
    modeExpiresAt: sessionDeadline(now),
    assignedOperatorId: null,
  });
  if (!transitioned) {
    // Кто-то успел раньше (дребезг кнопки, гонка команды и callback'а).
    // Сессия есть — значит «уже открыта», а не «не получилось».
    return { status: 'already_open' };
  }

  await ports.delivery.toClient(SUPPORT_GREETING, { withFinishButton: true });
  await ports.state.append({
    role: 'assistant',
    content: SUPPORT_GREETING,
    meta: { source: 'support_greeting' },
  });
  ports.analytics.track({ name: 'support_session_started', surface: opts.surface });
  return { status: 'opened' };
}

/**
 * Обработать входящее клиента.
 *
 * ⚠️ Текст клиента в переписку пишет ВЫЗЫВАЮЩИЙ (бот делает это для любого
 * сообщения, не только в сессии). Модуль записывает то, что порождает сам:
 * ответы помощника и подпись вложения.
 */
export async function handleSupportMessage(
  ports: SupportPorts,
  input: {
    text: string;
    kind: 'text' | 'media';
    /** Что положить в переписку вместо вложения: «[фото]» / «[файл]». */
    mediaPlaceholder?: string;
    now?: Date;
  },
): Promise<SupportOutcome> {
  const now = input.now ?? new Date();
  const snapshot = await ports.state.read();
  // Состояние прочитать нечем — решать нечего. Вызывающий уводит клиента в
  // сегодняшний флоу к человеку, а не молчит.
  if (!snapshot) return { status: 'state_unavailable' };

  const { mode, expired } = effectiveMode(snapshot, now);

  if (expired) {
    // Хороним истёкшую сессию, чтобы в БД и в панели не висел вечный `ai`.
    // Сбой перехода некритичен: клиент всё равно уходит по ветке `idle`.
    await ports.state.transition({
      from: 'ai',
      to: 'idle',
      trigger: 'ttl',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    ports.analytics.track({ name: 'support_session_closed', reason: 'ttl' });
  }

  if (mode === 'operator') {
    if (input.kind === 'media') {
      await ports.delivery.toClient(SUPPORT_MEDIA_TO_OPERATOR);
      if (input.mediaPlaceholder) {
        await ports.state.append({ role: 'user', content: input.mediaPlaceholder });
      }
      return { status: 'media_rejected' };
    }
    return { status: 'operator_leads' };
  }

  if (mode === 'idle') return { status: 'not_in_session' };

  if (input.kind === 'media') {
    await ports.delivery.toClient(SUPPORT_MEDIA_TO_AI, { withFinishButton: true });
    if (input.mediaPlaceholder) {
      await ports.state.append({ role: 'user', content: input.mediaPlaceholder });
    }
    await ports.state.touch('ai', sessionDeadline(now));
    return { status: 'media_rejected' };
  }

  // Ключа нет при включённом флаге — ведём себя РОВНО как при выключённом
  // флаге (спека §10): сессию гасим, клиент уходит в сегодняшний флоу к
  // человеку. ⚠️ Именно гасим, а не эскалируем: эскалация запирает разговор в
  // режиме оператора, из которого клиента выводит только человек, — и одна
  // забытая переменная окружения превращала бы КАЖДОГО написавшего в
  // недостижимого для бота. Алёрт о пропавшем ключе шлёт сам порт.
  if (!ports.model.configured()) {
    await ports.state.transition({
      from: 'ai',
      to: 'idle',
      trigger: 'ai_disabled',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    return { status: 'not_in_session' };
  }

  const used = await ports.state.countAiReplies(new Date(now.getTime() - 24 * HOUR_MS));
  if (used >= DAILY_AI_REPLY_CAP) {
    await ports.delivery.toClient(SUPPORT_CAP_REACHED);
    await ports.state.transition({
      from: 'ai',
      to: 'idle',
      trigger: 'cap',
      modeExpiresAt: null,
      assignedOperatorId: null,
    });
    ports.analytics.track({ name: 'support_session_closed', reason: 'cap' });
    return { status: 'capped' };
  }

  const history = await loadMaskedHistory(ports, input.text);

  // `null` — помощник недоступен; порт уже записал причину в лог и Sentry.
  const reply = await ports.model.reply(history);
  if (!reply) {
    return await escalate(ports, { trigger: 'ai_unavailable', reason: null, now });
  }

  const text = reply.text.trim();
  if (!text) {
    // Пустой ответ — это молчание бота, которое читается как поломка. Отдаём
    // клиента человеку: сказать нам нечего.
    return await escalate(ports, { trigger: 'ai_unavailable', reason: null, now });
  }

  await ports.delivery.toClient(text, { withFinishButton: true });
  await ports.state.append({
    role: 'assistant',
    content: text,
    meta: {
      source: SUPPORT_AI_META_SOURCE,
      model: reply.model,
      usage: reply.usage,
      ...(reply.toolsUsed.length > 0 ? { tools_used: reply.toolsUsed } : {}),
      ...(reply.incomplete ? { incomplete: true } : {}),
    },
  });
  await ports.state.touch('ai', sessionDeadline(now));
  ports.analytics.track({
    name: 'support_ai_reply',
    toolsUsed: reply.toolsUsed.length,
    guarded: false,
  });
  return { status: 'answered' };
}

/**
 * История для модели: без служебных строк, с пометкой оператора, замаскированная.
 *
 * Схлопывание подряд идущих ролей и обрезка ведущего `assistant` живут в ОБЩЕЙ
 * `toAgentHistory` — там же, где для продажного агента и веб-чата. Своя копия
 * этих правил была бы зеркалом (инвариант 10) в самом дорогом месте: обрезка
 * ведущего `assistant` — это инвариант H-1, без которого Messages API отвечает
 * 400 на КАЖДЫЙ ход, и чинить его в двух местах никто не будет.
 */
async function loadMaskedHistory(
  ports: SupportPorts,
  currentText: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  // Порт тотальный: недоступная история — пустой массив, ход идёт без
  // контекста (как одиночный ход продажного агента).
  const rows = await ports.state.history(HISTORY_LIMIT);

  return toAgentHistory(
    rows.map((r, i) => ({ id: String(i), role: r.role, content: r.content, createdAt: new Date(0) })),
    currentText,
    { operatorPrefix: OPERATOR_HISTORY_PREFIX, mask: maskForModel },
  );
}

/**
 * Передать разговор человеку.
 *
 * Порядок жёсткий: переход → текст клиенту → уведомление персонала. Клиент
 * узнаёт первым, потому что он ждёт ответа прямо сейчас; уведомление идёт
 * последним, потому что его сбой не должен помешать переходу — иначе
 * недоставленное уведомление оставляло бы разговор у помощника, который уже
 * сказал «передаю оператору».
 */
export async function escalate(
  ports: SupportPorts,
  input: {
    trigger: SupportEscalationTrigger;
    reason: string | null;
    now?: Date;
    /** Текст клиенту. По умолчанию — по триггеру и часам операторов. */
    clientText?: string;
  },
): Promise<SupportOutcome> {
  const now = input.now ?? new Date();

  const { transitioned } = await ports.state.transition({
    from: ['idle', 'ai'],
    to: 'operator',
    trigger: input.trigger,
    reason: input.reason,
    // ⚠️ null, а не срок: неотвеченное обращение не гаснет никогда.
    modeExpiresAt: null,
    assignedOperatorId: null,
  });

  if (!transitioned) {
    // Кто-то успел раньше (второй триггер в том же ходе, оператор из панели).
    // Второе «передаю оператору» клиенту не отправляем.
    return { status: 'escalated', trigger: input.trigger };
  }

  const text =
    input.clientText ??
    (input.trigger === 'ai_unavailable' ? aiUnavailableText(now) : escalationText(now));
  await ports.delivery.toClient(text);

  // Контекст для оператора — украшение; обращение важнее, и порт истории
  // тотальный: его отказ уже записан в лог и даёт пустой список.
  const lastMessages = await ports.state.history(HISTORY_LIMIT);

  const delivered = await ports.staff.notifyEscalation({
    trigger: input.trigger,
    reason: input.reason,
    lastMessages: lastMessages.map((m) => ({ ...m, content: maskForModel(m.content) })),
  });

  await ports.state.append({
    role: 'assistant',
    content: text,
    meta: {
      source: 'support_escalation',
      trigger: input.trigger,
      support_request: true,
      support_delivered: delivered,
    },
  });

  ports.analytics.track({ name: 'support_escalated', trigger: input.trigger });
  return { status: 'escalated', trigger: input.trigger };
}

/**
 * Закрыть сессию помощника.
 *
 * `silent` — для `/start`: клиент сам ушёл в меню, и «диалог завершён» вдогонку
 * выглядит как спор с его же действием.
 */
export async function closeSupportSession(
  ports: SupportPorts,
  input: { reason: SupportCloseReason; silent?: boolean; now?: Date },
): Promise<{ closed: boolean }> {
  const now = input.now ?? new Date();
  const snapshot = await ports.state.read();
  if (!snapshot) return { closed: false };

  // ⚠️ Смотрим на СЫРОЙ режим, а не на эффективный. У истёкшей сессии в БД
  // по-прежнему `ai`, и по эффективному режиму (`idle`) мы бы её не похоронили:
  // строка осталась бы вечным `ai`, а панель показывала бы разговор у
  // помощника, которого там давно нет.
  if (snapshot.mode !== 'ai') {
    // Разговор у человека `/start` и «Завершить» НЕ закрывают: сброс
    // относится к помощнику, а удержание оператора снимает только оператор.
    return { closed: false };
  }
  const { expired } = effectiveMode(snapshot, now);

  const { transitioned } = await ports.state.transition({
    from: 'ai',
    to: 'idle',
    trigger: expired ? 'ttl' : input.reason,
    modeExpiresAt: null,
    assignedOperatorId: null,
  });
  if (!transitioned) return { closed: false };

  // Истёкшую сессию хороним МОЛЧА в любом случае: клиент её уже покинул, и
  // «диалог завершён» через час после ухода читается как спам.
  if (!input.silent && !expired) {
    await ports.delivery.toClient(SUPPORT_CLOSED_BY_CLIENT);
  }
  ports.analytics.track({
    name: 'support_session_closed',
    reason: expired ? 'ttl' : input.reason,
  });
  return { closed: true };
}
