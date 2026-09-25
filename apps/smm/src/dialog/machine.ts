import { RUBRIC_KEYS, type RubricKey } from '../config/smm.config.ts';
import { NO_POST_ID, parseCallback, stampOf } from './callback.ts';
import {
  angleKeyboard,
  editChoiceKeyboard,
  failedKeyboard,
  AUTO_PREFIX,
  publishPendingKeyboard,
  rubricKeyboard,
  sourcePickKeyboard,
  publishedKeyboard,
  threadsPreviewKeyboard,
} from './keyboards.ts';
import { TEXTS } from './texts.ts';
import type {
  DialogEvent,
  Effect,
  FlowPayload,
  FlowState,
  Platform,
  Transition,
  TransitionContext,
} from './types.ts';
import { ADOPTABLE_STATES, PUBLISH_CHANNELS, TEXT_STATES } from './types.ts';

/**
 * Автомат диалога: чистая функция `transition(state, event, ctx)`.
 *
 * Ни сети, ни базы, ни времени изнутри: `now` приходит в контексте, эффекты
 * возвращаются данными. Из-за этого таблицу переходов можно проверить целиком
 * тестом, а не живым ботом.
 */

const IDLE: FlowState = { name: 'idle' };

function idleWith(effects: Effect[]): Transition {
  return { state: IDLE, effects };
}

function expiresAt(ctx: TransitionContext): string {
  return new Date(Date.parse(ctx.now) + ctx.questionTtlMs).toISOString();
}

function menu(): Effect {
  return { type: 'send', text: TEXTS.menu };
}

/** Клик по кнопке, которой здесь не ждут: клавиатура снимается, решения нет. */
function stale(event: Extract<DialogEvent, { kind: 'callback' }>, state: FlowState): Transition {
  const effects: Effect[] = [{ type: 'answer_callback', text: TEXTS.stale }];
  if (event.messageId !== undefined) {
    effects.push({ type: 'edit_keyboard', messageId: event.messageId, keyboard: null });
  }
  return { state, effects };
}

function rejectEffects(state: FlowState): Effect[] {
  if (state.postId === undefined) return [];
  return [{ type: 'decision', postId: state.postId, kind: 'reject' }];
}

function withPayload(state: FlowState, patch: FlowPayload): FlowPayload {
  return { ...state.payload, ...patch };
}

function isRubric(value: string): value is RubricKey {
  return (RUBRIC_KEYS as readonly string[]).includes(value);
}

/** Команды, которые исполнитель обслуживает сам: список, статистика, настройки. */
const PASSTHROUGH_COMMANDS: Record<string, 'queue' | 'stats' | 'settings'> = {
  '/queue': 'queue',
  '/stats': 'stats',
  '/settings': 'settings',
};

function handleCommand(
  state: FlowState,
  event: Extract<DialogEvent, { kind: 'command' }>,
  ctx: TransitionContext,
): Transition {
  const command = event.command.toLowerCase();

  if (command === '/cancel') {
    // Снимает незавершённый пост из ЛЮБОГО состояния: это выход, а не отмена
    // публикации (у той своя кнопка в окне ожидания).
    const effects: Effect[] = [...rejectEffects(state), { type: 'send', text: TEXTS.dropped }];
    if (state.name === 'post.publish_pending' && state.postId !== undefined) {
      effects.unshift({ type: 'cancel_publish', postId: state.postId });
    }
    return idleWith(effects);
  }

  if (command === '/start') {
    return idleWith([menu()]);
  }

  const passthrough = PASSTHROUGH_COMMANDS[command];
  if (passthrough !== undefined) {
    return { state, effects: [{ type: 'run', step: passthrough }] };
  }

  if (command === '/post' || command === '/threads') {
    const platform = command === '/threads' ? 'threads' : 'telegram';
    const input = event.args.trim();
    if (input === '') {
      return {
        state: { name: 'post.await_input', payload: { platform }, expiresAt: expiresAt(ctx) },
        effects: [{ type: 'send', text: TEXTS.askSource }],
      };
    }
    return {
      state: { name: 'post.generating', payload: { platform }, expiresAt: expiresAt(ctx) },
      effects: [
        { type: 'run', step: 'source', args: { input, platform } },
        { type: 'send', text: TEXTS.working },
      ],
    };
  }

  // Незнакомая команда — то же меню, что и свободный текст.
  return { state, effects: [menu()] };
}

function handleText(
  state: FlowState,
  event: Extract<DialogEvent, { kind: 'text' }>,
  ctx: TransitionContext,
): Transition {
  if (!TEXT_STATES.includes(state.name)) {
    // Текст вне ожидающего состояния получает меню, а не догадку. Модель к
    // свободному тексту не обращается никогда.
    if (state.name === 'post.generating') {
      return { state, effects: [{ type: 'send', text: TEXTS.stillWorking }] };
    }
    return { state, effects: [menu()] };
  }

  const text = event.text.trim();
  if (text === '') return { state, effects: [{ type: 'send', text: TEXTS.askSource }] };

  switch (state.name) {
    case 'post.await_input':
    case 'post.await_source_pick': {
      // Ссылка вместо кнопки — тот же ответ на тот же вопрос «дай источник».
      const platform = state.payload?.platform;
      return {
        state: {
          name: 'post.generating',
          ...(state.payload === undefined ? {} : { payload: state.payload }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          {
            type: 'run',
            step: 'source',
            args: { input: text, ...(platform === undefined ? {} : { platform }) },
          },
          { type: 'send', text: TEXTS.working },
        ],
      };
    }
    case 'post.await_edit_text':
      return {
        state: {
          name: 'post.generating',
          ...(state.postId === undefined ? {} : { postId: state.postId }),
          ...(state.payload === undefined ? {} : { payload: state.payload }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          { type: 'run', step: 'revise', args: { instruction: text, postId: state.postId } },
          { type: 'send', text: TEXTS.working },
        ],
      };
    case 'post.await_owner_text':
      return {
        state: {
          name: 'post.generating',
          ...(state.postId === undefined ? {} : { postId: state.postId }),
          ...(state.payload === undefined ? {} : { payload: state.payload }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          { type: 'run', step: 'owner_text', args: { text, postId: state.postId } },
          { type: 'send', text: TEXTS.working },
        ],
      };
    default:
      return { state, effects: [menu()] };
  }
}

function handleCallback(
  state: FlowState,
  event: Extract<DialogEvent, { kind: 'callback' }>,
  ctx: TransitionContext,
): Transition {
  const parsed = parseCallback(event.data);
  if (parsed === undefined) return stale(event, state);

  if (parsed.action.startsWith('i.')) {
    // Кнопки дайджеста идей: пост ещё не начат, тему называет сама кнопка.
    if (state.name !== 'idle') {
      return { state, effects: [{ type: 'answer_callback', text: TEXTS.notNow }] };
    }
    const itemId = parsed.id;
    if (parsed.action === 'i.skip') {
      return idleWith([
        { type: 'answer_callback', text: TEXTS.ideaSkipped },
        { type: 'item_verdict', itemId, verdict: 'skipped' },
      ]);
    }
    if (parsed.action === 'i.off') {
      // «Не по теме» — это память на будущее: тема уходит в исключения
      // ранжирования, иначе завтра её предложат снова.
      return idleWith([
        { type: 'answer_callback', text: TEXTS.ideaOfftopic },
        { type: 'item_verdict', itemId, verdict: 'offtopic' },
      ]);
    }
    if (parsed.action === 'i.write') {
      return {
        state: {
          name: 'post.generating',
          payload: { platform: 'telegram' },
          expiresAt: expiresAt(ctx),
        },
        effects: [
          { type: 'answer_callback' },
          // ⚠️ Отметку «написали» ставит САМ ШАГ после удачного разбора
          // источника: статья может не открыться, и помеченная тема из
          // дайджеста уже не вернулась бы.
          // Источник уже известен: вопрос «дай ссылку» владельцу не задаём.
          { type: 'run', step: 'source', args: { itemId, platform: 'telegram' } },
          { type: 'send', text: TEXTS.working },
        ],
      };
    }
    return stale(event, state);
  }

  if (parsed.action === 'q.show' || parsed.action === 'q.tshow' || parsed.action === 'q.drop') {
    // Кнопки из `/queue`: список печатается мимо автомата, поэтому пост
    // называет сама кнопка. Единственный гейт — занятость.
    if (state.name !== 'idle') {
      return { state, effects: [{ type: 'answer_callback', text: TEXTS.notNow }] };
    }
    if (parsed.action === 'q.drop') {
      return idleWith([
        { type: 'answer_callback' },
        { type: 'decision', postId: parsed.id, kind: 'reject' },
        { type: 'send', text: TEXTS.dropped },
      ]);
    }
    // Площадку называет САМА кнопка: список печатается мимо автомата, и
    // состояния, из которого её можно было бы прочитать, тут нет.
    const platform: Platform = parsed.action === 'q.tshow' ? 'threads' : 'telegram';
    return previewTransition(parsed.id, parsed.stamp, platform, { platform }, ctx, [
      { type: 'answer_callback' },
    ]);
  }

  if (parsed.action === 'thr') {
    // Кнопка живёт под ОПУБЛИКОВАННЫМ постом и переживает диалог: сверять её с
    // текущим состоянием нечем, пост называет она сама. Поэтому единственный
    // гейт — занятость: начатый пост чужой кнопкой не перебивается.
    if (state.name !== 'idle') {
      return { state, effects: [{ type: 'answer_callback', text: TEXTS.notNow }] };
    }
    return {
      state: { name: 'post.generating', expiresAt: expiresAt(ctx) },
      effects: [
        { type: 'answer_callback' },
        { type: 'run', step: 'threads', args: { parentPostId: parsed.id } },
        { type: 'send', text: TEXTS.working },
      ],
    };
  }

  if (parsed.action.startsWith(AUTO_PREFIX)) {
    // Кнопки черновика по расписанию: пост называет сама кнопка, а нажатие
    // «усыновляет» его в диалог — исполнитель сверит отпечаток с постом,
    // сделает его текущим и повторит нажатие обычным действием. Черновик не
    // трогает диалог, пока владелец его не коснулся.
    if (!ADOPTABLE_STATES.includes(state.name)) {
      return { state, effects: [{ type: 'answer_callback', text: TEXTS.notNow }] };
    }
    const action = parsed.action.slice(AUTO_PREFIX.length);
    if (action === '' || action.startsWith(AUTO_PREFIX)) return stale(event, state);
    return {
      state,
      effects: [
        {
          type: 'adopt',
          postId: parsed.id,
          action,
          stamp: parsed.stamp,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        },
      ],
    };
  }

  const currentStamp = state.payload?.stamp;
  const samePost =
    state.postId === undefined ? parsed.id === NO_POST_ID : state.postId === parsed.id;
  if (!samePost || currentStamp === undefined || currentStamp !== parsed.stamp) {
    // Чужой пост или чужой отпечаток: кнопка из старого сообщения.
    return stale(event, state);
  }

  // Кнопка «поста ещё нет» несёт метку, а не идентификатор: подставлять её
  // дальше нельзя — шаг стал бы искать пост с именем `new`.
  const postId = parsed.id === NO_POST_ID ? (state.postId ?? '') : parsed.id;
  const payload = state.payload ?? {};
  const answer: Effect = { type: 'answer_callback' };

  switch (state.name) {
    case 'post.await_source_pick': {
      const index = Number(parsed.action.replace('pick.', ''));
      const candidate = payload.candidates?.[index];
      if (parsed.action === 'drop') {
        return idleWith([answer, ...rejectEffects(state), { type: 'send', text: TEXTS.dropped }]);
      }
      if (!parsed.action.startsWith('pick.') || candidate === undefined) return stale(event, state);
      return {
        state: {
          name: 'post.generating',
          ...(postId === '' ? {} : { postId }),
          payload,
          expiresAt: expiresAt(ctx),
        },
        effects: [
          answer,
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          {
            type: 'run',
            step: 'source',
            args: {
              input: candidate.url,
              ...(postId === '' ? {} : { postId }),
              ...(payload.platform === undefined ? {} : { platform: payload.platform }),
            },
          },
          { type: 'send', text: TEXTS.working },
        ],
      };
    }

    case 'post.await_rubric': {
      if (!parsed.action.startsWith('rub.')) return stale(event, state);
      const rubric = parsed.action.slice('rub.'.length);
      if (!isRubric(rubric)) return stale(event, state);
      const angles = payload.angles ?? [];
      const stamp = stampOf({ angles, rubric });
      return {
        state: {
          name: 'post.await_angle',
          postId,
          payload: withPayload(state, { rubric, stamp, anglesShown: payload.anglesShown ?? 1 }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          answer,
          { type: 'persist', postId, patch: { rubric } },
          { type: 'decision', postId, kind: 'rubric', payload: { rubric } },
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          {
            type: 'send',
            text: TEXTS.askAngle(angles),
            keyboard: angleKeyboard(postId, stamp, angles, (payload.anglesShown ?? 1) < 2),
          },
        ],
      };
    }

    case 'post.await_angle': {
      if (parsed.action === 'more') {
        // «Другие углы» даётся один раз: дальше это уже перебор за деньги.
        if ((payload.anglesShown ?? 1) >= 2) return stale(event, state);
        return {
          state: { name: 'post.generating', postId, payload, expiresAt: expiresAt(ctx) },
          effects: [
            answer,
            ...(event.messageId === undefined
              ? []
              : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
            {
              type: 'run',
              step: 'angles',
              args: { postId, seenAngles: (payload.angles ?? []).map((angle) => angle.title) },
            },
            { type: 'send', text: TEXTS.working },
          ],
        };
      }
      if (!parsed.action.startsWith('ang.')) return stale(event, state);
      const index = Number(parsed.action.slice('ang.'.length));
      const angle = payload.angles?.[index];
      if (angle === undefined) return stale(event, state);
      return {
        state: {
          name: 'post.generating',
          postId,
          payload: withPayload(state, { angle: angle.title }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          answer,
          { type: 'persist', postId, patch: { angle: angle.title } },
          { type: 'decision', postId, kind: 'angle', payload: { angle: angle.title } },
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          {
            type: 'run',
            step: 'produce',
            args: { postId, rubric: payload.rubric, angle: angle.title },
          },
          { type: 'send', text: TEXTS.working },
        ],
      };
    }

    case 'post.previewed': {
      const channels = PUBLISH_CHANNELS.get(parsed.action);
      if (channels !== undefined) {
        const at = new Date(Date.parse(ctx.now) + ctx.undoSeconds * 1000).toISOString();
        return {
          state: {
            name: 'post.publish_pending',
            postId,
            payload: withPayload(state, { publishAt: at }),
            expiresAt: expiresAt(ctx),
          },
          effects: [
            answer,
            // Решение владельца — ФАКТ клика: слово «публикуй» текстом кнопку
            // не заменяет. Отпечаток текста и каналы уходят в журнал вместе с
            // решением: публикация читает каналы оттуда, а не из поля поста.
            { type: 'decision', postId, kind: 'approve', textSha: parsed.stamp, payload: { channels } },
            ...(event.messageId === undefined
              ? []
              : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
            { type: 'persist', postId, patch: { publishAt: at } },
            { type: 'schedule_publish', postId, at },
            {
              type: 'send',
              text: TEXTS.publishPending(ctx.undoSeconds),
              keyboard: publishPendingKeyboard(postId, parsed.stamp),
            },
          ],
        };
      }
      if (parsed.action === 'edit') {
        return {
          state: {
            name: 'post.await_edit_choice',
            postId,
            payload,
            expiresAt: expiresAt(ctx),
          },
          effects: [
            answer,
            { type: 'send', text: TEXTS.askEditChoice, keyboard: editChoiceKeyboard(postId, parsed.stamp) },
          ],
        };
      }
      if (parsed.action === 'angle') {
        const angles = payload.angles ?? [];
        if (angles.length === 0) {
          return {
            state: { name: 'post.generating', postId, payload, expiresAt: expiresAt(ctx) },
            effects: [
              answer,
              { type: 'run', step: 'angles', args: { postId, seenAngles: payload.seenAngles ?? [] } },
              { type: 'send', text: TEXTS.working },
            ],
          };
        }
        const stamp = stampOf({ angles, again: true });
        return {
          state: {
            name: 'post.await_angle',
            postId,
            payload: withPayload(state, { stamp }),
            expiresAt: expiresAt(ctx),
          },
          effects: [
            answer,
            {
              type: 'send',
              text: TEXTS.askAngle(angles),
              keyboard: angleKeyboard(postId, stamp, angles, (payload.anglesShown ?? 1) < 2),
            },
          ],
        };
      }
      if (parsed.action === 'drop') {
        return idleWith([
          answer,
          { type: 'decision', postId, kind: 'reject' },
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          { type: 'send', text: TEXTS.dropped },
        ]);
      }
      return stale(event, state);
    }

    case 'post.await_edit_choice': {
      if (parsed.action === 'edit.say') {
        return {
          state: { name: 'post.await_edit_text', postId, payload, expiresAt: expiresAt(ctx) },
          effects: [answer, { type: 'send', text: TEXTS.askEditText }],
        };
      }
      if (parsed.action === 'edit.own') {
        return {
          state: { name: 'post.await_owner_text', postId, payload, expiresAt: expiresAt(ctx) },
          effects: [answer, { type: 'send', text: TEXTS.askOwnerText }],
        };
      }
      if (parsed.action === 'back') {
        // Сам пост показывать заново незачем — он выше в переписке. Возвращаем
        // только кнопки, и кнопки ТОЙ площадки, с которой ушли в правки.
        if (payload.platform === 'threads') {
          return {
            state: { name: 'threads.previewed', postId, payload, expiresAt: expiresAt(ctx) },
            effects: [
              answer,
              {
                type: 'send',
                text: TEXTS.threadsReady,
                keyboard: threadsPreviewKeyboard(postId, parsed.stamp),
              },
            ],
          };
        }
        return {
          state: { name: 'post.previewed', postId, payload, expiresAt: expiresAt(ctx) },
          effects: [answer, { type: 'preview_controls', postId, stamp: parsed.stamp, note: 'ready' }],
        };
      }
      return stale(event, state);
    }

    case 'post.publish_pending': {
      if (parsed.action !== 'cancel') return stale(event, state);
      return {
        state: { name: 'post.previewed', postId, payload, expiresAt: expiresAt(ctx) },
        effects: [
          answer,
          { type: 'cancel_publish', postId },
          { type: 'decision', postId, kind: 'cancel' },
          { type: 'persist', postId, patch: { publishAt: null } },
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          { type: 'preview_controls', postId, stamp: parsed.stamp, note: 'cancelled' },
        ],
      };
    }

    case 'threads.previewed': {
      if (parsed.action === 'posted') {
        // Публикует ЧЕЛОВЕК: кнопка фиксирует факт, а не отправляет пост.
        return idleWith([
          answer,
          { type: 'decision', postId, kind: 'threads_posted', textSha: parsed.stamp },
          ...(event.messageId === undefined
            ? []
            : [{ type: 'edit_keyboard' as const, messageId: event.messageId, keyboard: null }]),
          { type: 'send', text: TEXTS.threadsPosted },
        ]);
      }
      if (parsed.action === 'edit') {
        return {
          state: { name: 'post.await_edit_choice', postId, payload, expiresAt: expiresAt(ctx) },
          effects: [
            answer,
            { type: 'send', text: TEXTS.askEditChoice, keyboard: editChoiceKeyboard(postId, parsed.stamp) },
          ],
        };
      }
      if (parsed.action === 'angle') {
        const angles = payload.angles ?? [];
        if (angles.length === 0) {
          return {
            state: { name: 'post.generating', postId, payload, expiresAt: expiresAt(ctx) },
            effects: [
              answer,
              { type: 'run', step: 'angles', args: { postId, seenAngles: payload.seenAngles ?? [] } },
              { type: 'send', text: TEXTS.working },
            ],
          };
        }
        const stamp = stampOf({ angles, again: true });
        return {
          state: {
            name: 'post.await_angle',
            postId,
            payload: withPayload(state, { stamp }),
            expiresAt: expiresAt(ctx),
          },
          effects: [
            answer,
            {
              type: 'send',
              text: TEXTS.askAngle(angles),
              keyboard: angleKeyboard(postId, stamp, angles, (payload.anglesShown ?? 1) < 2),
            },
          ],
        };
      }
      if (parsed.action === 'drop') {
        return idleWith([
          answer,
          { type: 'decision', postId, kind: 'reject' },
          { type: 'send', text: TEXTS.dropped },
        ]);
      }
      return stale(event, state);
    }

    case 'post.failed': {
      if (parsed.action === 'show') {
        return previewTransition(postId, parsed.stamp, payload.platform, payload, ctx, [answer]);
      }
      if (parsed.action === 'drop') {
        return idleWith([answer, { type: 'decision', postId, kind: 'reject' }, { type: 'send', text: TEXTS.dropped }]);
      }
      return stale(event, state);
    }

    default:
      return stale(event, state);
  }
}

/**
 * Экран готового поста: у площадки он свой (несколько сообщений и кнопка
 * «Выложил»), у канала — пост плюс клавиатура публикации. Площадка берётся из
 * СОСТОЯНИЯ: исход шага её называет не всегда (круг правок, «Показать как
 * есть»), и выбирать экран по нему значило бы предлагать выложить пост
 * площадки в канал.
 */
function previewTransition(
  postId: string,
  stamp: string,
  platform: Platform | undefined,
  payload: FlowPayload,
  ctx: TransitionContext,
  before: readonly Effect[] = [],
): Transition {
  if (platform === 'threads') {
    return {
      state: {
        name: 'threads.previewed',
        postId,
        payload: { ...payload, stamp, platform },
        expiresAt: expiresAt(ctx),
      },
      // Превью площадки собирает исполнитель: это несколько сообщений, и
      // кнопки живут на первом из них.
      effects: [...before, { type: 'preview', postId }],
    };
  }
  return {
    state: { name: 'post.previewed', postId, payload: { ...payload, stamp }, expiresAt: expiresAt(ctx) },
    effects: [
      ...before,
      { type: 'preview', postId },
      { type: 'preview_controls', postId, stamp, note: 'ready' },
    ],
  };
}

function handlePipelineDone(
  state: FlowState,
  event: Extract<DialogEvent, { kind: 'pipeline_done' }>,
  ctx: TransitionContext,
): Transition {
  const outcome = event.outcome;

  if (outcome.kind === 'candidates') {
    // Пост создаётся ПОСЛЕ выбора: до него в кнопке стоит метка «поста нет».
    const stamp = stampOf(outcome.candidates);
    return {
      state: {
        name: 'post.await_source_pick',
        ...(state.postId === undefined ? {} : { postId: state.postId }),
        payload: withPayload(state, { candidates: outcome.candidates, stamp }),
        expiresAt: expiresAt(ctx),
      },
      effects: [
        {
          type: 'send',
          text: TEXTS.askSourcePick(outcome.candidates),
          keyboard: sourcePickKeyboard(state.postId ?? NO_POST_ID, stamp, outcome.candidates),
        },
      ],
    };
  }

  if (outcome.kind === 'article') {
    // Источник прочитан: дальше досье и план — без вопросов владельцу.
    return {
      state: {
        name: 'post.generating',
        postId: outcome.postId,
        payload: state.payload ?? {},
        expiresAt: expiresAt(ctx),
      },
      effects: [{ type: 'run', step: 'plan', args: { postId: outcome.postId } }],
    };
  }

  if (outcome.kind === 'plan') {
    const stamp = stampOf({ rubric: outcome.rubric, angles: outcome.angles });
    return {
      state: {
        name: 'post.await_rubric',
        postId: outcome.postId,
        payload: withPayload(state, {
          angles: outcome.angles,
          rubric: outcome.rubric,
          stamp,
          anglesShown: (state.payload?.anglesShown ?? 0) + 1,
          seenAngles: [
            ...(state.payload?.seenAngles ?? []),
            ...outcome.angles.map((angle) => angle.title),
          ],
        }),
        expiresAt: expiresAt(ctx),
      },
      effects: [
        {
          type: 'send',
          text: TEXTS.askRubric,
          keyboard: rubricKeyboard(outcome.postId, stamp, outcome.rubric),
        },
      ],
    };
  }

  if (outcome.kind === 'published') {
    return {
      state: { name: 'idle' },
      effects: [
        {
          type: 'send',
          text: outcome.summary ?? TEXTS.published,
          keyboard: publishedKeyboard(outcome.postId, outcome.textSha.slice(0, 8)),
        },
      ],
    };
  }

  const platform = outcome.platform ?? state.payload?.platform;

  if (outcome.verdict === 'fail') {
    const stamp = outcome.textSha.slice(0, 8);
    return {
      state: {
        name: 'post.failed',
        postId: outcome.postId,
        payload: withPayload(state, { stamp, judgeSummary: outcome.summary ?? '', ...(platform === undefined ? {} : { platform }) }),
        expiresAt: expiresAt(ctx),
      },
      effects: [
        {
          type: 'send',
          text: TEXTS.failed(outcome.summary ?? ''),
          keyboard: failedKeyboard(outcome.postId, stamp),
        },
      ],
    };
  }

  // Превью канала — это САМ ПОСТ (как он уйдёт в канал), а кнопки живут
  // отдельным сообщением: у поста своя клавиатура рендера (кнопка продукта), и
  // подмешивать в неё «Опубликовать» значило бы показывать владельцу не то,
  // что увидит читатель.
  return previewTransition(
    outcome.postId,
    outcome.textSha.slice(0, 8),
    platform,
    withPayload(state, {}),
    ctx,
  );
}

export function transition(
  state: FlowState,
  event: DialogEvent,
  ctx: TransitionContext,
): Transition {
  // Истёкшее ожидание — idle. «Бот ждал ответа неделю» закрывается здесь.
  if (
    event.kind !== 'expired' &&
    state.expiresAt !== undefined &&
    Date.parse(state.expiresAt) <= Date.parse(event.at) &&
    state.name !== 'post.publish_pending'
  ) {
    const fresh: FlowState = IDLE;
    if (event.kind === 'callback') return stale(event, fresh);
    if (event.kind === 'text') {
      return { state: fresh, effects: [{ type: 'send', text: TEXTS.expired }] };
    }
    if (event.kind === 'command') return handleCommand(fresh, event, ctx);
  }

  switch (event.kind) {
    case 'command':
      return handleCommand(state, event, ctx);
    case 'text':
      return handleText(state, event, ctx);
    case 'callback':
      return handleCallback(state, event, ctx);
    case 'pipeline_done':
      return handlePipelineDone(state, event, ctx);
    case 'pipeline_failed': {
      const postId = event.postId ?? state.postId;
      if (postId === undefined) {
        return idleWith([{ type: 'send', text: TEXTS.stepFailed(event.message) }]);
      }
      // Отпечаток — от ТЕКСТА, а не от вопроса: кнопка «Показать как есть»
      // ведёт к публикации, а право на неё сверяется по отпечатку тела.
      if (event.reason === 'nothing_changes') {
        // Это не поломка, а вывод: тема не стоит поста. Под неё написан свой
        // текст с предложением дать другую ссылку.
        return idleWith([{ type: 'send', text: TEXTS.nothingChanges(event.message) }]);
      }
      const hasText = event.textSha !== undefined && event.textSha !== '';
      const stamp = hasText ? (event.textSha ?? '').slice(0, 8) : stampOf(event.message);
      return {
        state: {
          name: 'post.failed',
          postId,
          payload: withPayload(state, { stamp, judgeSummary: event.message }),
          expiresAt: expiresAt(ctx),
        },
        effects: [
          {
            type: 'send',
            text: TEXTS.stepFailed(event.message),
            keyboard: failedKeyboard(postId, stamp, hasText),
          },
        ],
      };
    }
    case 'timer_fired': {
      if (state.name !== 'post.publish_pending' || state.postId !== event.postId) {
        // Таймер от отменённой или чужой публикации: молча игнорируем, но
        // публиковать по нему нельзя.
        return { state, effects: [] };
      }
      return idleWith([{ type: 'run', step: 'publish', args: { postId: event.postId } }]);
    }
    case 'expired':
      return idleWith(state.name === 'idle' ? [] : rejectEffects(state));
    default:
      return { state, effects: [] };
  }
}
