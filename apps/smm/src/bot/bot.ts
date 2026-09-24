import { dirname, join } from 'node:path';

import { z } from 'zod';

import { Api, Bot, InputFile, type Context } from 'grammy';
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
import { ideaItems, ideasEmptyText } from './ideas-view.ts';
import { queueEmptyText, queueItems } from './queue-view.ts';
import { recoverPendingPublishes } from './recovery.ts';
import { createRunner } from './runner.ts';
import { runPolling, type PollingState } from './polling.ts';
import { AutodraftEnabled, createAutodraftScheduler, SETTINGS_AUTODRAFT_ENABLED } from './autodraft.ts';
import { createTicker, SETTINGS_DIGEST_ENABLED, SETTINGS_DIGEST_HOUR } from './ticker.ts';
import { buildReport, renderReport, type ReportPeriod } from '../stats/report.ts';
import { collectViews } from '../stats/views.ts';
import { check } from '../health/check.ts';
import { notifyIfRed } from '../health/notify.ts';
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

/** Как часто сторож здоровья ходит по проверкам. */
const HEALTH_EVERY_MS = 60 * 60 * 1000;

const DigestEnabled = z.boolean();
const DigestHour = z.number().int().min(0).max(23);

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
            : threadsPreviewKeyboard(target.postId, target.stamp, message.button, target.prefix ?? '');
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
    channels: deps.env.channels,
    config,
    // Обложки живут рядом с базой: один том в Dokploy, один бэкап.
    mediaDir: join(dirname(deps.env.dbPath), 'media'),
    resolve: {
      ...(deps.env.tavilyApiKey === undefined ? {} : { tavilyApiKey: deps.env.tavilyApiKey }),
      config,
    },
  });

  /**
   * Бот ВХОДА: все машинные сообщения в ops-группу уходят от него, а не от
   * бота канала — это правило ops-группы прода. Без токена сторож здоровья
   * только пишет в лог.
   */
  const opsApi = deps.env.ops.botToken === undefined ? undefined : new Api(deps.env.ops.botToken);

  async function sendOps(text: string, options: { toRoot?: boolean }): Promise<{ ok: boolean; staleThread?: boolean }> {
    const chatId = deps.env.ops.chatId;
    if (opsApi === undefined || chatId === undefined) {
      // Получателя в группе нет — пишем ВЛАДЕЛЬЦУ: молчание неотличимо от
      // тишины, а у бота есть с ним личка (инвариант ops-группы прода).
      try {
        await bot.api.sendMessage(ownerChatId, text);
        return { ok: true };
      } catch (error) {
        deps.logger.warn({ err: error }, 'сообщение о здоровье не доставлено владельцу');
        return { ok: false };
      }
    }
    try {
      await opsApi.sendMessage(chatId, text, {
        ...(options.toRoot === true || deps.env.ops.threadErrors === undefined
          ? {}
          : { message_thread_id: deps.env.ops.threadErrors }),
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ err: error }, 'сообщение в ops-группу не доставлено');
      return { ok: false, staleThread: /message thread not found/i.test(message) };
    }
  }

  async function runHealth(): Promise<void> {
    const status = await check({
      store: deps.store,
      ownerId: deps.env.ownerId,
      polling,
      checkBot: async () => {
        try {
          // Свой короткий поводок: сторож не должен висеть на Telegram.
          // Гонка с таймером, а не `signal`: у grammY свой тип сигнала, и
          // родной `AbortSignal` в него не подставляется.
          await Promise.race([
            bot.api.getMe(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('getMe не ответил за 5 с')), 5000).unref?.(),
            ),
          ]);
          return { ok: true };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
      ...(deps.env.model.apiKey === undefined ? {} : { modelApiKey: deps.env.model.apiKey }),
      ...(deps.env.tavilyApiKey === undefined ? {} : { tavilyApiKey: deps.env.tavilyApiKey }),
    });
    await notifyIfRed(status, { store: deps.store, logger: deps.logger, send: sendOps });
    deps.logger.info({ level: status.level }, 'проверка здоровья завершена');
  }

  let healthTimer: NodeJS.Timeout | undefined;
  /** Идёт ли приём команд. Проверка здоровья читает это, а не «сервис поднят». */
  const polling: PollingState = { running: false, reason: 'ещё не запускался' };

  /** Ответ на текущее нажатие: id колбэка живёт только внутри обработки апдейта. */
  let pendingCallback: ((text?: string) => Promise<void>) | undefined;

  const ports: BotPorts = {
    async send(text, keyboard, options) {
      const message = await bot.api.sendMessage(ownerChatId, text, {
        // Разметку просит вызывающий: обычные вопросы бота — простой текст,
        // а отчёт свёрстан HTML и без этого показывал владельцу сырые теги.
        ...(options?.html === true ? { parse_mode: 'HTML' as const } : {}),
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
      return runner.preview(postId);
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

  const ticker = createTicker({
    store: deps.store,
    pipeline: deps.pipeline,
    logger: deps.logger,
    config,
    sendDigest: handleIdeas,
    http: {},
    collectViews: async () => {
      // Витрина у каждого канала своя, и номера сообщений тоже: читаем по
      // одной, и каждая смотрит только свои посты.
      for (const channel of deps.env.channels) {
        const result = await collectViews({
          store: deps.store,
          logger: deps.logger,
          channel: { key: channel.key, username: channel.username },
          config,
        });
        // Снятые посты — это событие для владельца, а не строка в логе: пост
        // пропал из канала, и знать об этом он должен.
        for (const postId of result.withdrawn) {
          await bot.api.sendMessage(ownerChatId, `Пост ${postId} пропал с витрины канала ${channel.title}: помечен снятым.`);
        }
      }
    },
    sendWeekly: async () => {
      const text = await statsText('7d');
      const target = deps.env.groupId ?? ownerChatId;
      await bot.api.sendMessage(target, text, {
        parse_mode: 'HTML',
        ...(deps.env.groupId !== undefined && deps.env.groupThreadReports !== undefined
          ? { message_thread_id: deps.env.groupThreadReports }
          : {}),
      });
    },
    ...(deps.env.scrapeCreatorsApiKey === undefined
      ? {}
      : { scrapeCreatorsApiKey: deps.env.scrapeCreatorsApiKey }),
  });

  const engine = createEngine({
    store: deps.store,
    ports,
    logger: deps.logger,
    ownerId: deps.env.ownerId,
    undoSeconds: deps.env.publishUndoSeconds,
    channels: deps.env.channels,
    config,
  });

  // Черновики по расписанию пишутся мимо диалога: кнопки их превью называют
  // пост сами и усыновляют его в диалог только по нажатию владельца.
  const autodraft = createAutodraftScheduler({
    store: deps.store,
    runner,
    send: (text, keyboard) => ports.send(text, keyboard),
    logger: deps.logger,
    channels: deps.env.channels,
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

  /** Подписчиков спрашиваем у Telegram: в базе их нет и быть не может. */
  async function subscribers(chatId: string = deps.env.channelId): Promise<number | undefined> {
    try {
      // Свой короткий поводок: без него дефолт grammY — 500 с, и `/stats`
      // столько же молчит, а недельная сводка держит весь тикер.
      return await Promise.race([
        bot.api.getChatMemberCount(chatId),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('getChatMemberCount не ответил за 5 с')), 5000).unref?.(),
        ),
      ]);
    } catch (error) {
      // Бот мог не быть админом канала — отчёт из-за этого не пропадает.
      deps.logger.warn({ err: error }, 'число подписчиков не получено');
      return undefined;
    }
  }

  async function statsText(period: ReportPeriod): Promise<string> {
    const counts = await Promise.all(deps.env.channels.map((channel) => subscribers(channel.id)));
    const count = counts[0];
    const report = buildReport({
      store: deps.store,
      period,
      config,
      ...(count === undefined ? {} : { subscribers: count }),
      channels: deps.env.channels.map((channel, index) => {
        const people = counts[index];
        return {
          key: channel.key,
          title: channel.title,
          ...(people === undefined ? {} : { subscribers: people }),
        };
      }),
    });
    return renderReport(report);
  }

  async function handleIdeas(): Promise<void> {
    const lines = ideaItems(deps.store, { config });
    if (lines.length === 0) {
      await ports.send(ideasEmptyText());
      return;
    }
    for (const idea of lines) await ports.send(idea.line, idea.keyboard);
  }

  async function handleSettings(args: string): Promise<void> {
    // Две настройки живут в БАЗЕ, потому что их меняет владелец на ходу:
    // ежедневный дайджест и его час. Остальное — переменные окружения.
    const command = args.trim().toLowerCase();
    if (command === 'autodraft on' || command === 'autodraft off') {
      deps.store.settings.set(SETTINGS_AUTODRAFT_ENABLED, AutodraftEnabled, command.endsWith('on'));
    } else if (command === 'digest on' || command === 'digest off') {
      deps.store.settings.set(SETTINGS_DIGEST_ENABLED, DigestEnabled, command.endsWith('on'));
    } else if (command.startsWith('digest ')) {
      const hour = Number(command.slice('digest '.length));
      const { fromHour, toHour } = config.sources.pollWindowMsk;
      // ⚠️ Час обязан попадать в окно опроса: вне его прогона не бывает, и
      // дайджест не ушёл бы никогда при бодром «включён, 23:00» на экране.
      if (!Number.isInteger(hour) || hour < fromHour || hour >= toHour) {
        await ports.send(`Час дайджеста — целое число от ${fromHour} до ${toHour - 1} по Москве: вне этого окна бот источники не опрашивает.`);
        return;
      }
      deps.store.settings.set(SETTINGS_DIGEST_HOUR, DigestHour, hour);
      deps.store.settings.set(SETTINGS_DIGEST_ENABLED, DigestEnabled, true);
    } else if (command !== '') {
      await ports.send(
        'Не понял. Дайджест: /settings digest on | off | <час 0-23>. Черновики по расписанию: /settings autodraft on | off',
      );
      return;
    }

    const enabled = deps.store.settings.get(SETTINGS_DIGEST_ENABLED, DigestEnabled) ?? false;
    const hour = deps.store.settings.get(SETTINGS_DIGEST_HOUR, DigestHour) ?? 10;
    const autodraftOn = deps.store.settings.get(SETTINGS_AUTODRAFT_ENABLED, AutodraftEnabled) ?? true;
    const slots = config.autodraft.slotsMsk;
    const lines = [
      'Настройки:',
      `Черновики по расписанию: ${
        autodraftOn
          ? `включены — канал в ${slots.telegram.join(', ')}, Threads в ${slots.threads.join(', ')} МСК`
          : 'выключены'
      }`,
      `Ежедневный дайджест: ${enabled ? `включён, ${hour}:00 МСК` : 'выключен'}`,
      `Окно отмены: ${deps.env.publishUndoSeconds} с`,
      ...deps.env.channels.map(
        (channel) =>
          `Канал ${channel.title}: @${channel.username}${config.channels[channel.key].botButton ? '' : ' (без рекламы)'}`,
      ),
      `Модель автора: ${deps.env.model.writer}`,
      'Дайджест: /settings digest on | off | <час 0-23>. Черновики: /settings autodraft on | off. Остальное — переменные окружения.',
    ];
    await ports.send(lines.join('\n'));
  }

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const at = new Date().toISOString();
    const event: DialogEvent = text.startsWith('/')
      ? {
          kind: 'command',
          // Регистр не значит ничего: `/QUEUE` с телефона — обычное дело.
          command: (text.split(/\s+/)[0]?.split('@')[0] ?? text).toLowerCase(),
          args: text.slice(text.split(/\s+/)[0]?.length ?? 0).trim(),
          at,
        }
      : { kind: 'text', text, at };

    if (event.kind === 'command' && event.command === '/queue') {
      await handleQueue();
      return;
    }
    if (event.kind === 'command' && event.command === '/ideas') {
      await handleIdeas();
      return;
    }
    if (event.kind === 'command' && event.command === '/settings') {
      await handleSettings(event.args);
      return;
    }
    if (event.kind === 'command' && event.command === '/stats') {
      await ports.send(await statsText('30d'), undefined, { html: true });
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
      ticker.start();
      autodraft.start();
      // Здоровье проверяется СРАЗУ при старте и дальше раз в час: инцидент
      // 08.09.2026 (счёт провайдера в минусе) сутки жил незамеченным.
      void runHealth().catch((error: unknown) => {
        deps.logger.error({ err: error }, 'проверка здоровья сорвалась');
      });
      healthTimer = setInterval(() => {
        void runHealth().catch((error: unknown) => {
          deps.logger.error({ err: error }, 'проверка здоровья сорвалась');
        });
      }, HEALTH_EVERY_MS);
      healthTimer.unref?.();
      deps.logger.info({ commands: COMMANDS.length }, 'бот слушает');
      // `bot.start()` не возвращает управление, пока бот работает: запускаем
      // без ожидания, иначе сборка приложения не завершится.
      //
      // ⚠️ Через `runPolling`, а не напрямую: при выкате старый контейнер живёт
      // рядом с новым, Telegram отдаёт `getUpdates` одному, и проигравший
      // получает 409. Раньше цикл на этом останавливался — сервис `1/1`,
      // здоровье зелёное, а бот команды не принимал вовсе.
      void runPolling(
        {
          start: () => bot.start({ drop_pending_updates: true }),
          logger: deps.logger,
          onGiveUp: async (reason) => {
            await sendOps(
              ['[SMM] Бот не принимает команды', '', `Причина: ${reason}`, '',
               'Что делать: перезапустить приложение oplatishka-smm в Dokploy.'].join('\n'),
              {},
            );
          },
        },
        polling,
      );
    },
    async stop() {
      if (healthTimer !== undefined) {
        clearInterval(healthTimer);
        healthTimer = undefined;
      }
      ticker.stop();
      autodraft.stop();
      timers.stopAll();
      await bot.stop();
    },
  };
}

export { TEXTS as botTexts, type Context };
