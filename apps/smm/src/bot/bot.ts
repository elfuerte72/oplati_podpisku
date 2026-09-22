import { Bot, InputFile, type Context } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';

import type { SmmEnv } from '../config/env.ts';
import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { threadsPreviewKeyboard } from '../dialog/keyboards.ts';
import type { DialogEvent, Keyboard } from '../dialog/types.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { Logger } from '../logger.ts';
import type { PipelineDeps } from '../pipeline/types.ts';
import { grammyApi } from '../render/send.ts';
import type { Store } from '../store/index.ts';
import { createEngine, type Engine } from './engine.ts';
import type { BotPorts } from './ports.ts';
import { queueEmptyText, queueItems } from './queue-view.ts';
import { recoverPendingPublishes } from './recovery.ts';
import { createRunner } from './runner.ts';
import { createPublishTimers } from './timers.ts';

/**
 * Бот: единственное место, где живёт grammY.
 *
 * Слушается ТОЛЬКО владелец: чужое сообщение не получает ответа вовсе (лог
 * warn и тишина) — бот не должен отвечать даже «вам сюда нельзя», иначе он
 * становится поводом написать ещё раз.
 */

export interface SmmBotDeps {
  readonly env: SmmEnv;
  readonly store: Store;
  readonly logger: Logger;
  readonly pipeline: PipelineDeps;
  readonly config?: SmmConfig;
}

export interface SmmBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Для тестов и eval: обработать событие в обход Telegram. */
  readonly engine: Engine;
}

const COMMANDS = [
  { command: 'post', description: 'новый пост в канал' },
  { command: 'threads', description: 'пост для Threads' },
  { command: 'ideas', description: 'темы из источников' },
  { command: 'queue', description: 'черновики' },
  { command: 'stats', description: 'статистика и расход' },
  { command: 'settings', description: 'настройки' },
  { command: 'cancel', description: 'снять текущий пост' },
];

/**
 * Клавиатура автомата в разметку Bot API. Три вида кнопок: действие
 * (`callback_data`), ссылка (Web Intent Threads) и копирование текста —
 * последнее нужно, когда адрес intent не влез в лимит.
 */
function toReplyMarkup(keyboard?: Keyboard): InlineKeyboardMarkup | undefined {
  if (keyboard === undefined) return undefined;
  const rows = keyboard.rows.map((row) =>
    row.map((button): InlineKeyboardButton => {
      if (button.url !== undefined) return { text: button.text, url: button.url };
      if (button.copyText !== undefined) {
        return { text: button.text, copy_text: { text: button.copyText } };
      }
      return { text: button.text, callback_data: button.data ?? '' };
    }),
  );
  return { inline_keyboard: rows };
}

export function createSmmBot(deps: SmmBotDeps): SmmBot {
  const config = deps.config ?? smmConfig;
  const bot = new Bot(deps.env.botToken);
  const api = grammyApi(bot.api);
  const ownerChatId = deps.env.ownerId;

  const timers = createPublishTimers({ logger: deps.logger });
  const runner = createRunner({
    store: deps.store,
    async handoff(messages, target) {
      // Пост Threads уходит владельцу НЕСКОЛЬКИМИ сообщениями подряд: кнопки
      // автомата вешаются на первое — то, где лежит сам пост.
      for (const message of messages) {
        if (message.kind === 'photo' && message.photoPath !== undefined) {
          await bot.api.sendPhoto(ownerChatId, new InputFile(message.photoPath), {
            caption: message.text,
          });
          continue;
        }
        const keyboard =
          message.button === undefined
            ? undefined
            : threadsPreviewKeyboard(target.postId, target.stamp, message.button);
        await bot.api.sendMessage(ownerChatId, message.text, {
          ...(message.html === true ? { parse_mode: 'HTML' as const } : {}),
          ...(keyboard === undefined ? {} : { reply_markup: toReplyMarkup(keyboard) }),
          link_preview_options: { is_disabled: true },
        });
      }
    },
    pipeline: deps.pipeline,
    api,
    logger: deps.logger,
    ownerId: deps.env.ownerId,
    ownerChatId,
    channelId: deps.env.channelId,
    config,
    resolve: {
      ...(deps.env.tavilyApiKey === undefined ? {} : { tavilyApiKey: deps.env.tavilyApiKey }),
      config,
    },
  });

  /** Ответ на текущее нажатие: id колбэка живёт только внутри обработки апдейта. */
  let pendingCallback: ((text?: string) => Promise<void>) | undefined;

  const ports: BotPorts = {
    async send(text, keyboard) {
      const message = await bot.api.sendMessage(ownerChatId, text, {
        ...(toReplyMarkup(keyboard) === undefined ? {} : { reply_markup: toReplyMarkup(keyboard) }),
        link_preview_options: { is_disabled: true },
      });
      return message.message_id;
    },
    async editKeyboard(messageId, keyboard) {
      try {
        await bot.api.editMessageReplyMarkup(ownerChatId, messageId, {
          ...(keyboard === null ? {} : { reply_markup: toReplyMarkup(keyboard) }),
        });
      } catch (error) {
        // Сообщение могло быть удалено или клавиатура уже снята: это не повод
        // ронять обработку апдейта.
        deps.logger.warn({ messageId, err: error }, 'клавиатуру снять не удалось');
      }
    },
    async answerCallback(text) {
      if (pendingCallback === undefined) return;
      await pendingCallback(text);
    },
    async preview(postId) {
      await runner.preview(postId);
    },
    async runStep(step, args) {
      return runner.runStep(step, args);
    },
    schedulePublish(postId, at) {
      timers.schedule(postId, at, (id) => {
        void engine.handle({ kind: 'timer_fired', postId: id, at: new Date().toISOString() });
      });
    },
    cancelPublish(postId) {
      timers.cancel(postId);
    },
  };

  const engine = createEngine({
    store: deps.store,
    ports,
    logger: deps.logger,
    ownerId: deps.env.ownerId,
    undoSeconds: deps.env.publishUndoSeconds,
    config,
  });

  /** Гейт владельца. Чужому не отвечаем вовсе. */
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    if (from !== deps.env.ownerId) {
      deps.logger.warn({ from, chat: ctx.chat?.id }, 'сообщение не от владельца: игнорирую');
      return;
    }
    if (ctx.chat !== undefined && ctx.chat.type !== 'private') {
      // В группах бот только ШЛЁТ (превью в «Черновики»): команды там не
      // принимаются, иначе любой участник увидит кнопки владельца.
      deps.logger.info({ chat: ctx.chat.id }, 'команда в группе игнорируется');
      return;
    }
    await next();
  });

  async function handleQueue(): Promise<void> {
    const items = queueItems(deps.store);
    if (items.length === 0) {
      await ports.send(queueEmptyText());
      return;
    }
    for (const item of items) await ports.send(item.line, item.keyboard);
  }

  async function handleSettings(): Promise<void> {
    const lines = [
      'Настройки:',
      `Окно отмены: ${deps.env.publishUndoSeconds} с`,
      `Канал: ${deps.env.channelUsername}`,
      `Модель автора: ${deps.env.model.writer}`,
      'Меняются переменными окружения приложения.',
    ];
    await ports.send(lines.join('\n'));
  }

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const at = new Date().toISOString();
    const event: DialogEvent = text.startsWith('/')
      ? {
          kind: 'command',
          command: text.split(/\s+/)[0]?.split('@')[0] ?? text,
          args: text.slice(text.split(/\s+/)[0]?.length ?? 0).trim(),
          at,
        }
      : { kind: 'text', text, at };

    if (event.kind === 'command' && event.command === '/queue') {
      await handleQueue();
      return;
    }
    if (event.kind === 'command' && event.command === '/settings') {
      await handleSettings();
      return;
    }
    await engine.handle(event);
  });

  bot.on('callback_query:data', async (ctx) => {
    // ⚠️ Ответ на КАЖДЫЙ колбэк обязателен: без него клиент крутит часики до
    // минуты и выглядит зависшим.
    let answered = false;
    pendingCallback = async (text?: string): Promise<void> => {
      if (answered) return;
      answered = true;
      await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
    };
    try {
      await engine.handle({
        kind: 'callback',
        data: ctx.callbackQuery.data,
        at: new Date().toISOString(),
        ...(ctx.callbackQuery.message === undefined
          ? {}
          : { messageId: ctx.callbackQuery.message.message_id }),
      });
    } finally {
      if (!answered) await ctx.answerCallbackQuery();
      pendingCallback = undefined;
    }
  });

  bot.catch((error) => {
    deps.logger.error({ err: error.error }, 'ошибка обработки апдейта');
  });

  return {
    engine,
    async start() {
      await bot.api.setMyCommands(COMMANDS);
      const recovery = recoverPendingPublishes(deps.store, deps.logger, deps.env.ownerId);
      if (recovery.message !== undefined) {
        await bot.api.sendMessage(ownerChatId, recovery.message);
      }
      deps.logger.info({ commands: COMMANDS.length }, 'бот слушает');
      // `bot.start()` не возвращает управление, пока бот работает: запускаем
      // без ожидания, иначе сборка приложения не завершится.
      void bot.start({ drop_pending_updates: true }).catch((error: unknown) => {
        deps.logger.error({ err: error }, 'long polling остановился');
      });
    },
    async stop() {
      timers.stopAll();
      await bot.stop();
    },
  };
}

export { TEXTS as botTexts, type Context };
