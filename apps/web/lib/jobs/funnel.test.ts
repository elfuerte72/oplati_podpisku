import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Джоба воронки (тикеты 03–06) через ГЛАВНЫЙ шов: реальный привратник +
 * реальные сборщики сообщений, подменены только БД и транспорт Telegram.
 * Ассертится внешнее поведение: «дано состояние БД и время → такие-то
 * сообщения ушли такому-то клиенту, такие-то claim'ы заняты».
 *
 * Но-бэкфилл по датам (событие старше окна не выбирается) — интеграционные
 * тесты выборок на PGlite (`packages/db/src/funnel.integration.test.ts`);
 * здесь проверяются ГРАНИЦЫ окон, которые джоба передаёт выборкам.
 */

type SentRow = { userId: string; kind: string; at: Date };

const h = vi.hoisted(() => {
  const state = {
    env: {
      RETENTION_FUNNEL_ENABLED: true,
      REFERRAL_ENABLED: false,
      REVIEWS_CHAT_URL: undefined as string | undefined,
      REFERRAL_MINIAPP_DEEPLINK: false,
      TELEGRAM_MINIAPP_SHORTNAME: undefined as string | undefined,
      // Кнопка msg4 — web_app на Mini App: deployment-url читает APP_URL.
      APP_URL: 'https://example.com',
    },
    users: new Map<string, { telegramId: string | null; funnelOptOutAt: Date | null }>(),
    operator: new Set<string>(),
    claims: new Set<string>(),
    sentLog: [] as SentRow[],
    expiredRows: [] as { orderId: string; userId: string }[],
    freshUsers: [] as { userId: string }[],
    completedRows: [] as { orderId: string; userId: string; serviceId: string | null }[],
    ratedRows: [] as { userId: string }[],
    referralCodes: new Map<string, string>(),
    botUsernameError: false,
    // Переопределения текстов воронки (панель v2): пусто — дефолты из кода;
    // `textsFail` — БД при чтении оверлея недоступна.
    textOverrides: [] as { key: string; value: string; updatedAt: Date; updatedBy: null; updatedByName: null }[],
    textsFail: false,
  };
  return {
    state,
    sendMessageMock: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
    captureException: vi.fn(),
    windows: {} as Record<string, { from: Date; to: Date }>,
  };
});

vi.mock('@/lib/env.server', () => ({ serverEnv: h.state.env }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException, captureMessage: vi.fn() }));
vi.mock('@/lib/telegram/bot', () => ({
  getBot: () => ({ api: { sendMessage: h.sendMessageMock } }),
  getBotUsername: vi.fn(async () => {
    if (h.state.botUsernameError) throw new Error('getMe failed');
    return 'oplatishkaa_bot';
  }),
}));
vi.mock('@oplati/db', () => ({
  getDb: () => ({}),
  // Выборки: окна записываем для ассертов границ.
  findExpiredOrdersForSurvey: vi.fn(async (_db: unknown, w: { from: Date; to: Date }) => {
    h.windows.expired = w;
    return h.state.expiredRows;
  }),
  findFreshUsersWithoutOrders: vi.fn(async (_db: unknown, w: { from: Date; to: Date }) => {
    h.windows.start = w;
    return h.state.freshUsers;
  }),
  findCompletedOrdersForRating: vi.fn(async (_db: unknown, w: { from: Date; to: Date }) => {
    h.windows.rating = w;
    return h.state.completedRows;
  }),
  findRatedUsersForReferralNudge: vi.fn(async (_db: unknown, w: { from: Date; to: Date }) => {
    h.windows.nudge = w;
    return h.state.ratedRows;
  }),
  // Привратник: состояние пользователя и счётчики поверх sentLog/claims —
  // семантика та же, что у настоящих репозиториев (клейм = строка журнала).
  getFunnelUserState: vi.fn(async (_db: unknown, userId: string) => {
    return h.state.users.get(userId) ?? null;
  }),
  hasActiveOperatorConversation: vi.fn(
    async (_db: unknown, userId: string) => h.state.operator.has(userId),
  ),
  countFunnelSendsSince: vi.fn(async (_db: unknown, userId: string, since: Date) => {
    return h.state.sentLog.filter((r) => r.userId === userId && r.at >= since).length;
  }),
  getLastFunnelSendAt: vi.fn(async (_db: unknown, userId: string, kind: string) => {
    const rows = h.state.sentLog
      .filter((r) => r.userId === userId && r.kind === kind)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return rows[0]?.at ?? null;
  }),
  claimFunnelSend: vi.fn(
    async (
      _db: unknown,
      input: { userId: string; kind: string; orderId?: string | null },
    ) => {
      const key =
        input.kind === 'order_rating'
          ? `rating:${input.orderId}`
          : `${input.userId}:${input.kind}`;
      if (h.state.claims.has(key)) return false;
      h.state.claims.add(key);
      h.state.sentLog.push({ userId: input.userId, kind: input.kind, at: new Date() });
      return true;
    },
  ),
  getServiceById: vi.fn(async (_db: unknown, id: string) =>
    id === 'svc-spotify' ? { name: 'Spotify' } : null,
  ),
  ensureReferralCode: vi.fn(async (_db: unknown, userId: string) => {
    const code = h.state.referralCodes.get(userId);
    if (!code) throw new Error('no code arranged');
    return code;
  }),
  listFunnelTextOverrides: vi.fn(async () => {
    if (h.state.textsFail) throw new Error('connection refused');
    return h.state.textOverrides;
  }),
  // Ниже — то, что тянут транзитивные импорты (funnel-callbacks → notify-staff).
  listStaffRecipients: vi.fn(async () => []),
  getOrderById: vi.fn(async () => null),
  recordClientFeedback: vi.fn(async () => true),
  setFunnelOptOut: vi.fn(async () => undefined),
}));

import { runFunnelJob } from './funnel.ts';
import { invalidateFunnelTexts } from '../funnel/texts.ts';
import {
  EXPIRED_SURVEY_TEXT,
  START_SURVEY_TEXT,
} from '../telegram/templates.ts';
import { formatReferralTelegramLink } from '../cabinet/referral-read.ts';

// 12:00 МСК — активные часы воронки; 23:00 МСК — тихое окно.
const NOON = new Date('2026-09-01T09:00:00Z');
const NIGHT = new Date('2026-09-01T20:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

function addTgUser(userId: string) {
  h.state.users.set(userId, { telegramId: `tg-${userId}`, funnelOptOutAt: null });
}

type SentMessage = { chatId: unknown; text: string; markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } };
function sentMessages(): SentMessage[] {
  return h.sendMessageMock.mock.calls.map((c) => ({
    chatId: c[0],
    text: c[1] as string,
    markup: (c[2] as { reply_markup?: SentMessage['markup'] } | undefined)?.reply_markup,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.env.RETENTION_FUNNEL_ENABLED = true;
  h.state.env.REFERRAL_ENABLED = false;
  h.state.users.clear();
  h.state.operator.clear();
  h.state.claims.clear();
  h.state.sentLog = [];
  h.state.expiredRows = [];
  h.state.freshUsers = [];
  h.state.completedRows = [];
  h.state.ratedRows = [];
  h.state.referralCodes.clear();
  h.state.botUsernameError = false;
  h.state.textOverrides = [];
  h.state.textsFail = false;
  invalidateFunnelTexts();
  h.windows = {} as typeof h.windows;
});

describe('runFunnelJob — общий контур', () => {
  it('флаг выключен → ни выборок, ни отправок', async () => {
    h.state.env.RETENTION_FUNNEL_ENABLED = false;
    h.state.expiredRows = [{ orderId: 'o1', userId: 'u1' }];

    const res = await runFunnelJob({ now: NOON });

    expect(res.enabled).toBe(false);
    expect(res.expiredSurvey).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    expect(h.windows.expired).toBeUndefined();
  });

  it('окна выборок: msg1 −24ч…−3ч, msg2 −72ч…−24ч, msg3 −24ч…−1ч, msg4 −96ч…−48ч', async () => {
    h.state.env.REFERRAL_ENABLED = true;
    await runFunnelJob({ now: NOON });

    expect(h.windows.expired?.from.getTime()).toBe(NOON.getTime() - 24 * HOUR_MS);
    expect(h.windows.expired?.to.getTime()).toBe(NOON.getTime() - 3 * HOUR_MS);
    expect(h.windows.start?.from.getTime()).toBe(NOON.getTime() - 72 * HOUR_MS);
    expect(h.windows.start?.to.getTime()).toBe(NOON.getTime() - 24 * HOUR_MS);
    expect(h.windows.rating?.from.getTime()).toBe(NOON.getTime() - 24 * HOUR_MS);
    expect(h.windows.rating?.to.getTime()).toBe(NOON.getTime() - 1 * HOUR_MS);
    expect(h.windows.nudge?.from.getTime()).toBe(NOON.getTime() - 96 * HOUR_MS);
    expect(h.windows.nudge?.to.getTime()).toBe(NOON.getTime() - 48 * HOUR_MS);
  });

  it('тихое окно: ночью ничего не уходит И claim не занимается — сообщение не сгорает', async () => {
    addTgUser('u1');
    h.state.expiredRows = [{ orderId: 'o1', userId: 'u1' }];

    const res = await runFunnelJob({ now: NIGHT });

    expect(res.expiredSurvey).toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    expect(h.state.claims.size).toBe(0);
  });
});

describe('msg1 — опрос протухшего заказа', () => {
  it('шлёт опрос с кнопками причин и отпиской; повторный прогон молчит (claim)', async () => {
    addTgUser('u1');
    h.state.expiredRows = [{ orderId: 'o1', userId: 'u1' }];

    const first = await runFunnelJob({ now: NOON });
    expect(first.expiredSurvey).toEqual({ sent: 1, skipped: 0, errors: 0 });

    const [msg] = sentMessages();
    expect(msg?.chatId).toBe('tg-u1');
    expect(msg?.text).toBe(EXPIRED_SURVEY_TEXT);
    const callbacks = msg?.markup?.inline_keyboard.flat().map((b) => b.callback_data);
    // Кнопки причин несут заказ-триггер (связка «причина ↔ заказ» в feedback).
    expect(callbacks).toContain('fb:exp:price:o1');
    expect(callbacks).toContain('fb:exp:other:o1');
    expect(callbacks).toContain('fb:optout');

    // Идемпотентность: тот же снимок БД (выборка окном шире шага крона всё
    // ещё видит заказ) → второй прогон не шлёт ничего.
    const second = await runFunnelJob({ now: NOON });
    expect(second.expiredSurvey).toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('два протухших заказа одного клиента в окне → один опрос', async () => {
    addTgUser('u1');
    h.state.expiredRows = [
      { orderId: 'o1', userId: 'u1' },
      { orderId: 'o2', userId: 'u1' },
    ];

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey.sent).toBe(1);
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('отписанный клиент и разговор у оператора — не получают ничего', async () => {
    h.state.users.set('opted', { telegramId: 'tg-opted', funnelOptOutAt: new Date() });
    addTgUser('op');
    h.state.operator.add('op');
    h.state.expiredRows = [
      { orderId: 'o1', userId: 'opted' },
      { orderId: 'o2', userId: 'op' },
    ];

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey).toEqual({ sent: 0, skipped: 2, errors: 0 });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('msg2 — «/start без заказа»', () => {
  it('шлёт вопрос с кнопками и отпиской', async () => {
    addTgUser('u2');
    h.state.freshUsers = [{ userId: 'u2' }];

    const res = await runFunnelJob({ now: NOON });

    expect(res.startSurvey).toEqual({ sent: 1, skipped: 0, errors: 0 });
    const [msg] = sentMessages();
    expect(msg?.text).toBe(START_SURVEY_TEXT);
    const callbacks = msg?.markup?.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toContain('fb:st:thinking');
    expect(callbacks).toContain('fb:optout');
  });
});

describe('msg3 — оценка после покупки', () => {
  it('называет сервис из заказа, звёзды несут orderId; custom — нейтральная форма', async () => {
    addTgUser('u3');
    addTgUser('u4');
    h.state.completedRows = [
      { orderId: 'oa', userId: 'u3', serviceId: 'svc-spotify' },
      { orderId: 'ob', userId: 'u4', serviceId: null },
    ];

    const res = await runFunnelJob({ now: NOON });

    expect(res.orderRating).toEqual({ sent: 2, skipped: 0, errors: 0 });
    const [first, second] = sentMessages();
    expect(first?.text).toContain('Spotify');
    expect(second?.text).toContain('подписку');
    expect(second?.text).not.toContain('Spotify');
    const callbacks = first?.markup?.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toContain('fb:rate:1:oa');
    expect(callbacks).toContain('fb:rate:5:oa');
    expect(callbacks).toContain('fb:optout');
  });

  it('второй completed того же клиента внутри 90 дней не спрашивается', async () => {
    addTgUser('u5');
    // Прошлая оценка месяц назад — журнал уже содержит отправку.
    h.state.claims.add('rating:old-order');
    h.state.sentLog.push({
      userId: 'u5',
      kind: 'order_rating',
      at: new Date(NOON.getTime() - 30 * 24 * HOUR_MS),
    });
    h.state.completedRows = [{ orderId: 'oc', userId: 'u5', serviceId: null }];

    const res = await runFunnelJob({ now: NOON });

    expect(res.orderRating).toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(h.sendMessageMock).not.toHaveBeenCalled();
    // Claim НЕ занят: через 90 дней окно откроется, и заказ уже уйдёт из
    // окна выборки — но чужой claim не должен висеть.
    expect(h.state.claims.has('rating:oc')).toBe(false);
  });
});

describe('msg4 — реферальное касание', () => {
  it('REFERRAL_ENABLED выключен → тишина, выборка не зовётся', async () => {
    h.state.ratedRows = [{ userId: 'u6' }];

    const res = await runFunnelJob({ now: NOON });

    expect(res.referralNudge).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(h.windows.nudge).toBeUndefined();
  });

  it('ссылка в тексте совпадает с той, что отдаёт кабинет (общий формат)', async () => {
    h.state.env.REFERRAL_ENABLED = true;
    addTgUser('u7');
    h.state.ratedRows = [{ userId: 'u7' }];
    h.state.referralCodes.set('u7', 'CODE7');

    const res = await runFunnelJob({ now: NOON });

    expect(res.referralNudge).toEqual({ sent: 1, skipped: 0, errors: 0 });
    const expected = formatReferralTelegramLink('CODE7', 'oplatishkaa_bot', null);
    const [msg] = sentMessages();
    expect(expected).toBeTruthy();
    expect(msg?.text).toContain(expected!);
    const callbacks = msg?.markup?.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toContain('fb:optout');
  });

  it('bot-username не резолвится → фаза пропущена целиком, claim «раз за жизнь» не сгорает', async () => {
    h.state.env.REFERRAL_ENABLED = true;
    addTgUser('u8');
    h.state.ratedRows = [{ userId: 'u8' }];
    h.state.referralCodes.set('u8', 'CODE8');
    h.state.botUsernameError = true;

    const res = await runFunnelJob({ now: NOON });

    expect(res.referralNudge).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(h.state.claims.size).toBe(0);
    expect(h.sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('бюджет между фазами', () => {
  it('второе сообщение тому же клиенту в один прогон режется дневным бюджетом', async () => {
    addTgUser('u9');
    h.state.expiredRows = [{ orderId: 'o9', userId: 'u9' }];
    h.state.completedRows = [{ orderId: 'o9c', userId: 'u9', serviceId: null }];

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey.sent).toBe(1);
    expect(res.orderRating).toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('деградация прогона (история 18)', () => {
  it('сбой одного кандидата — errors++, остальные обрабатываются', async () => {
    addTgUser('bad');
    addTgUser('good');
    h.state.expiredRows = [
      { orderId: 'ob', userId: 'bad' },
      { orderId: 'og', userId: 'good' },
    ];
    const db = await import('@oplati/db');
    vi.mocked(db.getFunnelUserState).mockImplementationOnce(async () => {
      throw new Error('db down for one');
    });

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey).toEqual({ sent: 1, skipped: 0, errors: 1 });
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('send_failed (не-403 отказ Telegram после claim) считается ошибкой, а не skip', async () => {
    addTgUser('u10');
    h.state.expiredRows = [{ orderId: 'o10', userId: 'u10' }];
    h.sendMessageMock.mockRejectedValueOnce(new Error('telegram 500'));

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey).toEqual({ sent: 0, skipped: 0, errors: 1 });
  });

  it('сбой выборки одной фазы не глушит остальные фазы', async () => {
    addTgUser('u11');
    h.state.freshUsers = [{ userId: 'u11' }];
    const db = await import('@oplati/db');
    vi.mocked(db.findExpiredOrdersForSurvey).mockRejectedValueOnce(new Error('table broken'));

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey.errors).toBe(1);
    expect(res.startSurvey).toEqual({ sent: 1, skipped: 0, errors: 0 });
  });
});

describe('тексты воронки из реестра (панель v2, тикет 10)', () => {
  it('переопределение в БД → крон шлёт новый текст и новую подпись кнопки', async () => {
    addTgUser('u1');
    h.state.expiredRows = [{ orderId: 'o1', userId: 'u1' }];
    h.state.textOverrides = [
      { key: 'expired_survey.body', value: 'Что помешало оплатить заказ?', updatedAt: new Date(), updatedBy: null, updatedByName: null },
      { key: 'expired_survey.answer.price', value: 'Слишком дорого', updatedAt: new Date(), updatedBy: null, updatedByName: null },
    ];

    await runFunnelJob({ now: NOON });

    const msg = sentMessages()[0];
    expect(msg?.text).toBe('Что помешало оплатить заказ?');
    const labels = msg?.markup?.inline_keyboard.flat().map((b) => b.text) ?? [];
    expect(labels).toContain('Слишком дорого');
    expect(labels).not.toContain('💸 Дорого');
  });

  it('подстановка {service} заполняется из заказа; для заказа вне каталога — текст без подстановки', async () => {
    addTgUser('u1');
    h.state.completedRows = [
      { orderId: 'o1', userId: 'u1', serviceId: 'svc-spotify' },
    ];
    h.state.textOverrides = [
      { key: 'order_rating.body', value: 'Как вам {service}? Оцените.', updatedAt: new Date(), updatedBy: null, updatedByName: null },
    ];

    await runFunnelJob({ now: NOON });

    expect(sentMessages()[0]?.text).toBe('Как вам Spotify? Оцените.');
  });

  it('оверлей не прочитался → прогон пропускается целиком, claim не сгорает', async () => {
    // Каждое сообщение здесь одноразовое, а claim занимается ДО отправки:
    // разослав дефолт, мы лишили бы этих клиентов правки владельца навсегда.
    // Следующий прогон через 15 минут, окна выборок шире шага — не теряется
    // ничего, кроме одного цикла.
    addTgUser('u1');
    h.state.expiredRows = [{ orderId: 'o1', userId: 'u1' }];
    h.state.textsFail = true;

    const res = await runFunnelJob({ now: NOON });

    expect(res.expiredSurvey).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(sentMessages()).toHaveLength(0);
    expect(h.captureException).toHaveBeenCalled();
  });
});
