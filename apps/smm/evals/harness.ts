import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { smmConfig, type ModelRole, type SmmConfig } from '../src/config/smm.config.ts';
import { buildCallback } from '../src/dialog/callback.ts';
import type { DialogEvent, Keyboard, StateName } from '../src/dialog/types.ts';
import { createLogger, type Logger } from '../src/logger.ts';
import type { Model, ModelResult } from '../src/llm/model.ts';
import { createEngine, type Engine } from '../src/bot/engine.ts';
import type { BotPorts } from '../src/bot/ports.ts';
import { createRunner } from '../src/bot/runner.ts';
import type { SendApi } from '../src/render/send.ts';
import type { Fetcher, Resolver } from '../src/sources/http.ts';
import { openStore, type Store } from '../src/store/index.ts';

/**
 * Харнес сценариев: диалог целиком, от команды владельца до публикации.
 *
 * Сценарий — ДАННЫЕ (JSON), а не код: его читает человек, и новый случай из
 * жизни добавляется файлом, а не новым тестом. Ответы модели и страницы
 * источников — записанные, поэтому прогон детерминированный и идёт в CI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const StepSchema = z.object({
  /** Что делает владелец. */
  command: z.string().optional(),
  args: z.string().optional(),
  /**
   * Аргумент для ЖИВОГО прогона. Фикстурный адрес в интернете не существует, и
   * без замены живой прогон падал бы на первом же шаге независимо от модели.
   */
  liveArgs: z.string().optional(),
  text: z.string().optional(),
  /** Нажатие кнопки: действие ищется среди кнопок последнего сообщения. */
  click: z.string().optional(),
  /** Чего ждём после шага. */
  expectState: z.string().optional(),
  expectSendContains: z.string().optional(),
  expectButtons: z.array(z.string()).optional(),
  expectPostStatus: z.string().optional(),
  expectChannelPost: z.boolean().optional(),
});

const ScenarioSchema = z.object({
  name: z.string().min(1),
  why: z.string().min(1),
  /** Записанные ответы модели по ролям, по одному на вызов. */
  model: z.record(z.array(z.unknown())).default({}),
  /** Записанные страницы источников: адрес (префикс) → тело. */
  pages: z.record(z.string()).default({}),
  steps: z.array(StepSchema).min(1),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

export function loadScenarios(dir = join(HERE, 'scenarios')): Scenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const parsed = ScenarioSchema.safeParse(raw);
      if (!parsed.success) {
        // Негодный сценарий — ошибка автора сценария, и молчать о ней нельзя:
        // иначе прогон «зелёный», потому что ничего не проверял.
        throw new Error(`сценарий ${file} не разобрался: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

export interface RunOutcome {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly sends: readonly { text: string; keyboard?: Keyboard }[];
  readonly channelPosts: number;
}

function fixtureModel(answers: Record<string, unknown[]>): Model {
  const queues = new Map<string, unknown[]>(Object.entries(answers).map(([role, list]) => [role, [...list]]));
  function next(role: ModelRole): ModelResult<never> {
    const value = queues.get(role)?.shift();
    if (value === undefined) {
      return { ok: false, reason: 'api_error', message: `в сценарии нет ответа роли ${role}` };
    }
    return { ok: true, value: value as never };
  }
  return {
    json(role) {
      return Promise.resolve(next(role));
    },
    markdown(role) {
      return Promise.resolve(next(role) as ModelResult<string>);
    },
  };
}

function fixtureFetcher(pages: Record<string, string>): Fetcher {
  return (url) => {
    const key = Object.keys(pages).find((candidate) => url.startsWith(candidate));
    if (key === undefined) return Promise.resolve(new Response('нет', { status: 404 }));
    return Promise.resolve(
      new Response(pages[key], { status: 200, headers: { 'content-type': 'text/html' } }),
    );
  };
}

const resolver: Resolver = () => Promise.resolve(['93.184.216.34']);

export interface HarnessOptions {
  readonly ownerId?: number;
  readonly channelId?: string;
  readonly config?: SmmConfig;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /**
   * Живой прогон: настоящая модель, настоящее хранилище расхода и настоящая
   * отправка в ТЕСТОВЫЙ канал. Страницы тоже настоящие — фикстурный транспорт
   * не подставляется.
   */
  readonly live?: { readonly model: Model; readonly store: Store; readonly api: SendApi };
  /** Адреса источников для живого прогона: у фикстурных страниц свои. */
  readonly livePages?: Record<string, string>;
}

/** Один сценарий целиком. Возвращает список расхождений, а не бросает. */
export async function runScenario(
  scenario: Scenario,
  options: HarnessOptions = {},
): Promise<RunOutcome> {
  const ownerId = options.ownerId ?? 379_336_096;
  // ⚠️ Дефолта БОЕВОГО канала здесь нет намеренно: ошибка в этом месте
  // необратима. Не назвали канал — сценарий «публикует» в никуда.
  const channelId = options.channelId ?? 'канал-не-назван';
  const logger = options.logger ?? createLogger({ level: 'fatal', stream: { write() {} } });
  const live = options.live;
  const store: Store = options.live?.store ?? openStore({ path: ':memory:' });
  const sends: { text: string; keyboard?: Keyboard }[] = [];
  const pending: Promise<void>[] = [];
  let channelPosts = 0;
  const failures: string[] = [];

  try {
    const runner = createRunner({
      store,
      pipeline: { model: live?.model ?? fixtureModel(scenario.model), logger },
      handoff(messages) {
        for (const message of messages) {
          sends.push({ text: message.text, ...(message.button === undefined ? {} : { keyboard: { rows: [[message.button]] } }) });
        }
        return Promise.resolve();
      },
      // В живом прогоне — НАСТОЯЩИЙ Bot API: сценарий обязан доходить до
      // канала, иначе он проверяет заглушку, а четыре документа обещают
      // обратное. Канал при этом только тестовый — гейт в `live.ts`.
      api:
        live === undefined
          ? {
              sendRichMessage(chat) {
                if (String(chat) === channelId) channelPosts += 1;
                return Promise.resolve({ message_id: 501 });
              },
              sendPhoto(chat) {
                if (String(chat) === channelId) channelPosts += 1;
                return Promise.resolve({ message_id: 502 });
              },
              sendMessage(chat, text) {
                if (String(chat) === channelId) channelPosts += 1;
                else sends.push({ text });
                return Promise.resolve({ message_id: 503 });
              },
            }
          : {
              async sendRichMessage(chat, rich, sendOptions) {
                const sent = await live.api.sendRichMessage(chat, rich, sendOptions);
                if (String(chat) === channelId) channelPosts += 1;
                return sent;
              },
              async sendPhoto(chat, photo, sendOptions) {
                const sent = await live.api.sendPhoto(chat, photo, sendOptions);
                if (String(chat) === channelId) channelPosts += 1;
                return sent;
              },
              async sendMessage(chat, text, sendOptions) {
                const sent = await live.api.sendMessage(chat, text, sendOptions);
                if (String(chat) === channelId) channelPosts += 1;
                else sends.push({ text });
                return sent;
              },
            },
      logger,
      ownerId,
      ownerChatId: ownerId,
      channelId,
      ...(options.config === undefined ? {} : { config: options.config }),
      // В живом прогоне страницы качаются по-настоящему: подставлять двойник
      // транспорта значило бы проверять конвейер на записанном интернете.
      ...(live === undefined ? { resolve: { fetcher: fixtureFetcher(scenario.pages), resolver } } : {}),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    const ports: BotPorts = {
      send(text, keyboard) {
        sends.push({ text, ...(keyboard === undefined ? {} : { keyboard }) });
        return Promise.resolve(sends.length);
      },
      editKeyboard() {
        return Promise.resolve();
      },
      answerCallback() {
        return Promise.resolve();
      },
      preview(postId) {
        return runner.preview(postId);
      },
      runStep(step, args) {
        return runner.runStep(step, args);
      },
      // Окно отмены в сценарии не ждём: публикация запускается сразу, иначе
      // прогон стоял бы минуту на каждом сценарии. ⚠️ Промис копится и
      // дожидается на шаге: иначе публикация доигрывалась бы уже после
      // закрытия базы («database is not open» в конце прогона).
      schedulePublish(postId) {
        pending.push(engine.handle({ kind: 'timer_fired', postId, at: new Date().toISOString() }));
      },
      cancelPublish() {},
    };

    const engine: Engine = createEngine({
      store,
      ports,
      logger,
      ownerId,
      undoSeconds: 0,
      ...(options.config === undefined ? {} : { config: options.config }),
    });

    for (const [index, step] of scenario.steps.entries()) {
      const at = new Date().toISOString();
      const before = sends.length;

      if (step.command !== undefined) {
        const args = (live === undefined ? step.args : (step.liveArgs ?? step.args)) ?? '';
        const event: DialogEvent = { kind: 'command', command: step.command, args, at };
        await engine.handle(event);
      } else if (step.text !== undefined) {
        await engine.handle({ kind: 'text', text: step.text, at });
      } else if (step.click !== undefined) {
        const state = engine.current();
        const stamp = state.payload?.stamp ?? 'idea';
        const postId = state.postId ?? lastPostId(store) ?? 'new';
        await engine.handle({
          kind: 'callback',
          data: buildCallback(step.click, postId, stamp),
          at,
          messageId: 1,
        });
      }

      // Отложенные эффекты (публикация по таймеру) доигрываются здесь же.
      while (pending.length > 0) await pending.shift();

      const fresh = sends.slice(before);
      const where = `шаг ${index + 1} (${step.command ?? step.text ?? step.click ?? '?'})`;

      if (step.expectState !== undefined && engine.current().name !== (step.expectState as StateName)) {
        failures.push(`${where}: состояние ${engine.current().name}, ждали ${step.expectState}`);
      }
      if (
        step.expectSendContains !== undefined &&
        !fresh.some((message) => message.text.includes(step.expectSendContains ?? ''))
      ) {
        failures.push(`${where}: в сообщениях нет «${step.expectSendContains}»`);
      }
      if (step.expectButtons !== undefined) {
        const labels = fresh.flatMap((message) => message.keyboard?.rows.flat() ?? []).map((button) => button.text);
        for (const label of step.expectButtons) {
          if (!labels.includes(label)) failures.push(`${where}: нет кнопки «${label}» (есть: ${labels.join(', ')})`);
        }
      }
      if (step.expectPostStatus !== undefined) {
        const postId = engine.current().postId ?? lastPostId(store);
        const status = postId === undefined ? undefined : store.posts.get(postId)?.status;
        if (status !== step.expectPostStatus) {
          failures.push(`${where}: статус поста ${status ?? 'нет поста'}, ждали ${step.expectPostStatus}`);
        }
      }
      if (step.expectChannelPost === true && channelPosts === 0) {
        failures.push(`${where}: в канал ничего не ушло`);
      }
      if (step.expectChannelPost === false && channelPosts > 0) {
        failures.push(`${where}: в канал ушёл пост, а не должен был`);
      }
    }
  } finally {
    // Живому прогону база нужна и после сценария: по ней считается расход.
    if (live === undefined) store.close();
  }

  return { ok: failures.length === 0, failures, sends, channelPosts };
}

/** Последний созданный пост: кнопки сценария могут ссылаться на него. */
function lastPostId(store: Store): string | undefined {
  const [post] = store.posts.listByStatus(
    ['draft', 'linted', 'reviewed', 'previewed', 'approved', 'published', 'handed', 'posted'],
    { limit: 1 },
  );
  return post?.id;
}

export { smmConfig };
