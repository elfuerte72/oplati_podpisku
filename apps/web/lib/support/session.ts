import {
  SUPPORT_AI_META_SOURCE,
  type ConversationModeTrigger,
  type SupportEscalationTrigger,
} from '@oplati/types';

import { toAgentHistory } from '../chat/history';

import { matchHardTrigger } from './hard-triggers';
import { maskForModel, maskForStaff } from './mask';
import { guardModelOutput } from './output-guard';
import type {
  ConversationSnapshot,
  SupportCloseReason,
  SupportPorts,
  SupportSurface,
} from './ports';
import {
  SUPPORT_CAP_REACHED,
  SUPPORT_CLOSED_BY_CLIENT,
  SUPPORT_GREETING,
  SUPPORT_GUARDED,
  SUPPORT_MEDIA_PLACEHOLDER,
  SUPPORT_MEDIA_TO_AI,
  SUPPORT_MEDIA_TO_OPERATOR,
  SUPPORT_OPERATOR_LEADS,
  aiUnavailableText,
  escalationText,
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

/**
 * Как часто пингуем персонал о новых сообщениях клиента в разговоре, который
 * ведёт человек. Ждущий ответа пишет пять раз подряд — оператору нужен один
 * пинг, не пять.
 */
export const FOLLOW_UP_DEDUP_MINUTES = 30;

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

/**
 * Закрыть сессию помощника: `ai → idle` без срока и ведущего. Четыре места
 * звали переход с одинаковым телом — разъезд одного из них (забытый
 * `assignedOperatorId: null`) оставлял бы призрачного ведущего.
 */
async function closeToIdle(ports: SupportPorts, trigger: ConversationModeTrigger): Promise<boolean> {
  const { transitioned } = await ports.state.transition({
    from: 'ai',
    to: 'idle',
    trigger,
    modeExpiresAt: null,
    assignedOperatorId: null,
  });
  return transitioned;
}

export function sessionDeadline(now: Date): Date {
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
    // Разговор у человека: перевод обратно в помощника отменил бы решение
    // оператора. Но и МОЛЧАТЬ нельзя — человек нажал кнопку и ждёт хоть
    // чего-то; говорим, кто ведёт и что ответ придёт сюда же.
    await ports.delivery.toClient(SUPPORT_OPERATOR_LEADS);
    return { status: 'operator_leads' };
  }

  if (mode === 'ai') {
    // Сессия уже открыта: продлеваем срок и НЕ повторяем приветствие.
    await ports.state.touch('ai', sessionDeadline(now));
    return { status: 'already_open' };
  }

  // Ключа нет — сессию НЕ открываем: приветствие без единого ответа за ним
  // хуже, чем сразу сегодняшний флоу к человеку. Порт сам алёртит.
  if (!ports.model.configured()) return { status: 'unavailable' };

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
 * ⚠️ Текст клиента в переписку пишет МОДУЛЬ, а не бот — потому что только
 * модуль знает режим: в `operator` строке нужен маркер обращения (панель
 * считает «без ответа» от последнего такого), в `ai` — обычная реплика, а в
 * `idle` бот пишет сам, как раньше. Пиши и бот, и модуль — реплика клиента
 * лежала бы в ленте дважды.
 */
export async function handleSupportMessage(
  ports: SupportPorts,
  input: {
    text: string;
    kind: 'text' | 'media';
    /** Что положить в переписку вместо вложения: «[фото]» / «[файл]». */
    mediaPlaceholder?: string;
    /** Meta строки клиента (id апдейта/сообщения Telegram) — как пишет бот. */
    userMeta?: Record<string, unknown>;
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
    await closeToIdle(ports, 'ttl');
    ports.analytics.track({ name: 'support_session_closed', reason: 'ttl' });
  }

  if (mode === 'operator') {
    if (input.kind === 'media') {
      // Вложение — тоже реплика клиента (спека §1: `operator → operator` —
      // touch; §8 — маркер обращения и пинг персоналу). Без этого клиент,
      // ответивший оператору скриншотом, через сутки закрывался бы кроном как
      // «молчавший», а «без ответа» его не видел бы.
      await ports.delivery.toClient(SUPPORT_MEDIA_TO_OPERATOR);
      await noteClientFollowUp(
        ports,
        input.mediaPlaceholder ?? SUPPORT_MEDIA_PLACEHOLDER.file,
        now,
        input.userMeta,
      );
      return { status: 'media_rejected' };
    }
    await noteClientFollowUp(ports, input.text, now, input.userMeta);
    return { status: 'operator_leads' };
  }

  if (mode === 'idle') return { status: 'not_in_session' };

  // Реплика клиента в сессии помощника — ДО любого исхода ниже: и жёсткий
  // триггер, и кап, и ответ модели должны видеть её в ленте.
  if (input.kind === 'text') {
    await ports.state.append({ role: 'user', content: input.text, meta: input.userMeta });
  }

  if (input.kind === 'media') {
    await ports.delivery.toClient(SUPPORT_MEDIA_TO_AI, { withFinishButton: true });
    if (input.mediaPlaceholder) {
      await ports.state.append({ role: 'user', content: input.mediaPlaceholder });
    }
    await ports.state.touch('ai', sessionDeadline(now));
    return { status: 'media_rejected' };
  }

  // Жёсткий триггер — ПЕРВЫМ, до ключа и до капа. «Верните деньги» или «вы
  // мошенники» должны попасть к человеку независимо от того, доступна ли
  // модель и остался ли у клиента лимит: человек важнее и того и другого.
  const hard = matchHardTrigger(input.text);
  if (hard) {
    return await escalate(ports, {
      trigger: 'hard',
      reason: `${hard.category}: «${hard.matched}»`,
      now,
    });
  }

  // Ключа нет при включённом флаге — ведём себя РОВНО как при выключённом
  // флаге (спека §10): сессию гасим, клиент уходит в сегодняшний флоу к
  // человеку. ⚠️ Именно гасим, а не эскалируем: эскалация запирает разговор в
  // режиме оператора, из которого клиента выводит только человек, — и одна
  // забытая переменная окружения превращала бы КАЖДОГО написавшего в
  // недостижимого для бота. Алёрт о пропавшем ключе шлёт сам порт.
  if (!ports.model.configured()) {
    await closeToIdle(ports, 'ai_disabled');
    return { status: 'not_in_session' };
  }

  const used = await ports.state.countAiReplies(new Date(now.getTime() - 24 * HOUR_MS));
  if (used >= DAILY_AI_REPLY_CAP) {
    await ports.delivery.toClient(SUPPORT_CAP_REACHED);
    await closeToIdle(ports, 'cap');
    ports.analytics.track({ name: 'support_session_closed', reason: 'cap' });
    return { status: 'capped' };
  }

  const history = await loadMaskedHistory(ports, input.text);

  // Tool `request_human` эскалирует ПРЯМО во время хода — тем же путём, что
  // жёсткий триггер. Модуль запоминает факт, чтобы после хода не отправить
  // клиенту ещё и текст модели поверх «передаю оператору».
  let escalatedByModel: string | null = null;
  const hooks = {
    requestHuman: async (reason: string) => {
      escalatedByModel = reason;
      await escalate(ports, { trigger: 'model', reason, now });
    },
  };

  // `null` — помощник недоступен; порт уже записал причину в лог и Sentry.
  const reply = await ports.model.reply(history, hooks);
  if (escalatedByModel !== null) {
    return { status: 'escalated', trigger: 'model' };
  }
  if (!reply) {
    return await escalate(ports, { trigger: 'ai_unavailable', reason: null, now });
  }

  const text = reply.text.trim();
  if (!text) {
    // Пустой ответ — это молчание бота, которое читается как поломка. Отдаём
    // клиента человеку: сказать нам нечего.
    return await escalate(ports, { trigger: 'ai_unavailable', reason: null, now });
  }

  // Выходной фильтр — гарантия там, где промпт лишь просьба. Пойманный ответ
  // клиент не видит и в переписку он не пишется: строка с «PaySpace» в ленте
  // панели — тоже утечка, пусть и внутрь.
  const verdict = guardModelOutput(text);
  if (!verdict.ok) {
    ports.analytics.track({ name: 'support_ai_reply', toolsUsed: reply.toolsUsed.length, guarded: true });
    return await escalate(ports, {
      trigger: 'guard',
      reason: `${verdict.category}: «${verdict.matched}»`,
      now,
      clientText: SUPPORT_GUARDED,
    });
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
 * Клиент написал в разговор, который ведёт человек.
 *
 * Строка помечается маркером обращения — «без ответа» в панели считается от
 * ПОСЛЕДНЕГО сообщения клиента, а не от первого. Срок режима сбрасывается в
 * `null`: ждём ответа человека, и такой разговор не гаснет. Персонал пингуется
 * с дедупом: ждущий пишет подряд, а оператору хватит одного пинга в полчаса.
 */
async function noteClientFollowUp(
  ports: SupportPorts,
  text: string,
  now: Date,
  userMeta: Record<string, unknown> | undefined,
): Promise<void> {
  await ports.state.touch('operator', null);
  await ports.state.append({
    role: 'user',
    content: text,
    meta: { ...userMeta, support_request: true, source: 'support_follow_up' },
  });

  const last = await ports.staff.lastFollowUpAt();
  const dedupUntil = last ? last.getTime() + FOLLOW_UP_DEDUP_MINUTES * MINUTE_MS : 0;
  if (now.getTime() < dedupUntil) return;

  await ports.staff.notifyFollowUp({ text: maskForStaff(text) });
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
  // Причина от модели (`request_human`) пересказывает слова клиента — в ней
  // может оказаться номер карты. В служебную строку и в DM персоналу — под
  // маской, как и история.
  const reason = input.reason === null ? null : maskForStaff(input.reason);

  const { transitioned } = await ports.state.transition({
    from: ['idle', 'ai'],
    to: 'operator',
    trigger: input.trigger,
    reason,
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
    reason,
    lastMessages: lastMessages.map((m) => ({ ...m, content: maskForStaff(m.content) })),
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
  input: {
    // Без `operator`: оператор закрывает разговор роутом панели (`operator_close`),
    // а не через модуль — здесь только закрытия со стороны клиента и системы.
    reason: Exclude<SupportCloseReason, 'operator'>;
    silent?: boolean;
    now?: Date;
  },
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

  if (!(await closeToIdle(ports, expired ? 'ttl' : input.reason))) return { closed: false };

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
