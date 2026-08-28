import type {
  ConversationMode,
  ConversationModeTrigger,
  SupportEscalationTrigger,
} from '@oplati/types';

/**
 * Порты модуля поддержки (спека §3, «Testing Decisions» п. 1).
 *
 * Модуль — единственная точка обработки хода помощника, и он НЕ знает ни про
 * БД, ни про grammY, ни про провайдера модели. Всё внешнее приходит портами, и
 * это же единственный новый шов для тестов: матрица поведения (открытие, ход,
 * TTL, кап, медиа, деградация, эскалация) проверяется здесь, а не через
 * поднятый бот.
 *
 * Порты собираются НА КАЖДОЕ входящее и уже несут в себе адресата: chat_id
 * клиента, его userId, id разговора. Иначе каждый метод таскал бы их
 * параметрами, а модуль — следил, что передал те же самые.
 */

export type ConversationSnapshot = {
  mode: ConversationMode;
  modeExpiresAt: Date | null;
  assignedOperatorId: string | null;
};

export type SupportTransitionInput = {
  from: ConversationMode | readonly ConversationMode[];
  to: ConversationMode;
  trigger: ConversationModeTrigger;
  reason?: string | null;
  modeExpiresAt: Date | null;
  assignedOperatorId?: string | null;
};

export type SupportHistoryRow = {
  role: 'user' | 'assistant' | 'operator';
  content: string;
};

/** Состояние разговора и переписка. Реализация — репозиторий `support.ts`. */
export interface SupportStatePort {
  read(): Promise<ConversationSnapshot | null>;
  transition(input: SupportTransitionInput): Promise<{ transitioned: boolean }>;
  /** Продлить срок текущего режима. Служебной строки не пишет. */
  touch(mode: ConversationMode, modeExpiresAt: Date | null): Promise<void>;
  /** Сколько ответов помощник дал ЭТОМУ клиенту с момента `since`. */
  countAiReplies(since: Date): Promise<number>;
  /**
   * Последние строки переписки. НИКОГДА не бросает: недоступная история —
   * это ход без контекста, а не сорванный ответ клиенту. Отказ обязан
   * залогировать сама реализация — у неё есть логгер, у модуля его нет.
   */
  history(limit: number): Promise<SupportHistoryRow[]>;
  append(row: {
    role: 'user' | 'assistant';
    content: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
}

export type SupportModelReply = {
  text: string;
  model: string;
  /** Сырой usage провайдера — уходит в лог, в бюджет Anthropic НЕ попадает. */
  usage: unknown;
  toolsUsed: string[];
  incomplete: boolean;
};

/**
 * Что модель может сделать ВО ВРЕМЯ хода через tools. Модуль отдаёт хуки
 * порту, порт — обработчикам tools: так `request_human` из tool'а и жёсткий
 * триггер идут ОДНИМ путём эскалации, а не двумя.
 */
export interface SupportModelHooks {
  /** Модель позвала человека. Возвращает после того, как передача состоялась. */
  requestHuman(reason: string): Promise<void>;
}

export interface SupportModelPort {
  /** Есть ли ключ. Флаг включён без ключа обязан вести себя как выключённый. */
  configured(): boolean;
  /**
   * Ход модели. `null` — помощник недоступен (таймаут, 5xx после ретраев,
   * 401): реализация УЖЕ записала причину в лог и Sentry, модулю разбирать
   * нечего. Порт тотальный намеренно — иначе в модуле пришлось бы держать
   * пустой `catch`, а он запрещён конвенцией и гасит сигнал об аварии.
   */
  reply(
    history: { role: 'user' | 'assistant'; content: string }[],
    hooks: SupportModelHooks,
  ): Promise<SupportModelReply | null>;
}

/** Доставка клиенту в Telegram. `false` — не дошло (заблокировал бота, сбой). */
export interface SupportDeliveryPort {
  toClient(text: string, opts?: { withFinishButton?: boolean }): Promise<boolean>;
}

/** Уведомление персонала. `false` — НЕ доставлено. */
export interface SupportStaffPort {
  notifyEscalation(input: {
    trigger: SupportEscalationTrigger;
    reason: string | null;
    /** Последние реплики для контекста оператора. Уже замаскированы. */
    lastMessages: SupportHistoryRow[];
  }): Promise<boolean>;
  /** Клиент написал в разговор, который ведёт человек. Текст уже замаскирован. */
  notifyFollowUp(input: { text: string }): Promise<boolean>;
  /**
   * Когда персоналу в последний раз уходил пинг по ЭТОМУ разговору. Для
   * дедупа: ждущий ответа клиент пишет пять сообщений подряд, а оператору
   * нужен один пинг в полчаса, не пять.
   */
  lastFollowUpAt(): Promise<Date | null>;
}

export type SupportAnalyticsEvent =
  | { name: 'support_session_started'; surface: SupportSurface }
  | { name: 'support_ai_reply'; toolsUsed: number; guarded: boolean }
  | { name: 'support_escalated'; trigger: SupportEscalationTrigger }
  | { name: 'support_session_closed'; reason: SupportCloseReason };

export interface SupportAnalyticsPort {
  track(event: SupportAnalyticsEvent): void;
}

export interface SupportPorts {
  state: SupportStatePort;
  model: SupportModelPort;
  delivery: SupportDeliveryPort;
  staff: SupportStaffPort;
  analytics: SupportAnalyticsPort;
}

/** Откуда клиент вошёл в поддержку. */
export type SupportSurface = 'button' | 'command' | 'deeplink';

/** Почему разговор закрылся. */
export type SupportCloseReason = 'client' | 'operator' | 'ttl' | 'auto' | 'start' | 'cap';
