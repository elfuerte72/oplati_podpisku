import { beforeEach, describe, expect, it, vi } from "vitest";

// Обязательные ключи для lazy-валидации serverEnv.
process.env.APP_URL = "https://example.com";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
process.env.TELEGRAM_BOT_TOKEN = "123:test-token";

const h = vi.hoisted(() => ({
  trackMock: vi.fn(),
  sendMock: vi.fn(async () => undefined),
  state: { botAiEnabled: false },
}));

vi.mock("@/lib/analytics/track", () => ({ trackServer: h.trackMock }));

vi.mock("@/lib/env.server", () => ({
  serverEnv: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "BOT_AI_ENABLED") return h.state.botAiEnabled;
        if (prop === "REFERRAL_ENABLED") return false;
        return undefined;
      },
    },
  ),
}));

vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    configured: false,
    limit: 0,
    remaining: 0,
  })),
}));

vi.mock("./send", () => ({
  sendSafely: h.sendMock,
  showOrEdit: vi.fn(async () => undefined),
}));
vi.mock("./persist", () => ({
  persistInbound: vi.fn(async () => null),
  readPendingMeta: vi.fn(async () => null),
  safeAppendMessage: vi.fn(async () => undefined),
}));
vi.mock("./agent-dialog", () => ({
  runAgentDialog: vi.fn(async () => undefined),
}));
vi.mock("./bot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bot")>();
  return {
    ...actual,
    getBot: () => ({ api: { answerCallbackQuery: vi.fn(async () => {}) } }),
  };
});
vi.mock("./start-menu", () => ({
  handleStartCommand: vi.fn(async () => undefined),
}));
vi.mock("./support-flow", () => ({
  handleSupportCallback: vi.fn(async () => undefined),
  handleSupportCommand: vi.fn(async () => undefined),
  tryHandlePendingSupport: vi.fn(async () => false),
}));
vi.mock("./catalog-callbacks", () => ({
  handleOrderActionCallback: vi.fn(async () => undefined),
  handleServiceSelected: vi.fn(async () => undefined),
  handleTierSelected: vi.fn(async () => undefined),
  showCatalogList: vi.fn(async () => undefined),
  tryHandlePendingAmount: vi.fn(async () => false),
}));
vi.mock("./vpn-flow", () => ({
  handleVpnCallback: vi.fn(async () => undefined),
  handleVpnRefreshCallback: vi.fn(async () => undefined),
}));

import { handleTelegramUpdate } from "./handle-update";

function textUpdate(text: string, updateId = 100) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      chat: { id: 555, type: "private" as const },
      from: { id: 379336096, is_bot: false, first_name: "Тест" },
      text,
    },
  };
}

/**
 * Спрос, который бот при выключенном `BOT_AI_ENABLED` не обслуживает: клиент
 * пишет текст или шлёт медиа, а по делу ответа нет. Ни в логах по смыслу, ни в
 * БД этого нет — только событие.
 *
 * С тикета 09 в ответ уходит подсказка с кнопкой «Поддержка» (её поведение
 * проверяет `handle-update.silent-hint.test.ts`), но само событие остаётся: оно
 * меряет тот же спрос, и история сравнима.
 *
 * Тест существует ещё и потому, что на dev-стенде флаг ВКЛЮЧЁН
 * (`BOT_AI_ENABLED=1`), то есть вживую этот путь там не воспроизводится.
 */
describe("bot_text_ignored", () => {
  beforeEach(() => {
    h.trackMock.mockClear();
    h.sendMock.mockClear();
    h.state.botAiEnabled = false;
  });

  it("текст при выключенном AI пишет событие", async () => {
    await handleTelegramUpdate(textUpdate("хочу оплатить spotify"));

    expect(h.trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bot_text_ignored",
        telegramId: "379336096",
        props: expect.objectContaining({
          kind: "text",
          len: "хочу оплатить spotify".length,
        }),
      }),
    );
  });

  it("текст клиента в событие не попадает — только длина", async () => {
    await handleTelegramUpdate(textUpdate("мой телефон +79991234567"));

    const props = h.trackMock.mock.calls[0]?.[0]?.props as Record<
      string,
      unknown
    >;
    expect(props.kind).toBe("text");
    expect(props.len).toBe(24);
    expect(JSON.stringify(h.trackMock.mock.calls)).not.toContain("79991234567");
  });

  it("медиа при выключенном AI тоже считается потерей", async () => {
    await handleTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 2,
        chat: { id: 555, type: "private" as const },
        from: { id: 379336096, is_bot: false, first_name: "Тест" },
        photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      },
    });

    expect(h.trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bot_text_ignored",
        props: expect.objectContaining({ kind: "media" }),
      }),
    );
  });

  it("при включённом AI события нет — бот ответил, потери не было", async () => {
    h.state.botAiEnabled = true;
    await handleTelegramUpdate(textUpdate("хочу оплатить spotify", 102));

    const ignored = h.trackMock.mock.calls.filter(
      (c) => (c[0] as { name?: string })?.name === "bot_text_ignored",
    );
    expect(ignored).toHaveLength(0);
  });

  it("идемпотентность: повтор апдейта Telegram не удваивает событие", async () => {
    await handleTelegramUpdate(textUpdate("привет", 777));
    await handleTelegramUpdate(textUpdate("привет", 777));

    const keys = h.trackMock.mock.calls.map(
      (c) => (c[0] as { eventKey?: string })?.eventKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('tg-777-379336096-ignored');
  });
});

describe("bot_menu_click", () => {
  beforeEach(() => {
    h.trackMock.mockClear();
    h.state.botAiEnabled = false;
  });

  it("нажатие callback-кнопки пишет какая именно", async () => {
    await handleTelegramUpdate({
      update_id: 200,
      callback_query: {
        id: "cb1",
        from: { id: 379336096, is_bot: false, first_name: "Тест" },
        chat_instance: "ci",
        data: "vpn",
        message: {
          message_id: 3,
          chat: { id: 555, type: "private" as const },
        },
      },
    });

    expect(h.trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bot_menu_click",
        telegramId: "379336096",
        props: { button: "vpn" },
      }),
    );
  });

  it("составной callback пишет и кнопку, и её аргумент", async () => {
    await handleTelegramUpdate({
      update_id: 201,
      callback_query: {
        id: "cb2",
        from: { id: 379336096, is_bot: false, first_name: "Тест" },
        chat_instance: "ci",
        data: "svc:spotify",
        message: {
          message_id: 4,
          chat: { id: 555, type: "private" as const },
        },
      },
    });

    expect(h.trackMock).toHaveBeenCalledWith(
      expect.objectContaining({ props: { button: "svc", slug: "spotify" } }),
    );
  });
});
