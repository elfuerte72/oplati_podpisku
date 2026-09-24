import type { ChannelTarget } from '../config/env.ts';
import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { buildCallback } from '../dialog/callback.ts';
import { transition } from '../dialog/machine.ts';
import { TEXTS } from '../dialog/texts.ts';
import type {
  DecisionEffectKind,
  DialogEvent,
  Effect,
  FlowPayload,
  FlowState,
  StateName,
} from '../dialog/types.ts';
import { STATES } from '../dialog/types.ts';
import type { Logger } from '../logger.ts';
import type { Store } from '../store/index.ts';
import type { DecisionKind } from '../store/post-state.ts';
import type { PostPatch } from '../store/types.ts';
import { buildPreviewControls } from './channels.ts';
import type { BotPorts } from './ports.ts';

/**
 * Исполнитель: читает состояние, зовёт автомат, применяет эффекты.
 *
 * Состояние диалога читается и пишется ВОКРУГ перехода в одной транзакции, а
 * шаги конвейера идут вне её: они ходят в сеть и живут минутами, а держать на
 * это время транзакцию базы нельзя.
 */

/** Сколько событий подряд обрабатываем, прежде чем признать это циклом. */
const MAX_CHAIN = 12;

export interface EngineDeps {
  readonly store: Store;
  readonly ports: BotPorts;
  readonly logger: Logger;
  readonly ownerId: number;
  readonly undoSeconds: number;
  /**
   * Каналы публикации. Не заданы — один основной канал и прежние кнопки
   * (тесты и режим без второго канала).
   */
  readonly channels?: readonly ChannelTarget[];
  readonly config?: SmmConfig;
  readonly now?: () => Date;
}

export interface Engine {
  handle(event: DialogEvent): Promise<void>;
  /** Текущее состояние: нужно тестам и восстановлению после перезапуска. */
  current(): FlowState;
  reset(): void;
}

function isStateName(value: string): value is StateName {
  return (STATES as readonly string[]).includes(value);
}

export function createEngine(deps: EngineDeps): Engine {
  const config = deps.config ?? smmConfig;

  function read(): FlowState {
    const row = deps.store.flow.get(deps.ownerId);
    if (row === undefined) return { name: 'idle' };
    if (!isStateName(row.state)) {
      // Незнакомое состояние в базе — это след старой версии кода. Лучше
      // начать с чистого листа, чем работать с тем, чего нет в таблице.
      deps.logger.warn({ state: row.state }, 'неизвестное состояние диалога, сбрасываю');
      return { name: 'idle' };
    }
    return {
      name: row.state,
      ...(row.postId === undefined ? {} : { postId: row.postId }),
      ...(row.payload === undefined ? {} : { payload: row.payload as FlowPayload }),
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    };
  }

  function write(state: FlowState): void {
    if (state.name === 'idle') {
      deps.store.flow.clear(deps.ownerId);
      return;
    }
    deps.store.flow.set(deps.ownerId, {
      state: state.name,
      ...(state.postId === undefined ? {} : { postId: state.postId }),
      ...(state.payload === undefined ? {} : { payload: state.payload }),
      ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
    });
  }

  async function applyEffect(effect: Effect): Promise<DialogEvent | undefined> {
    switch (effect.type) {
      case 'send':
        await deps.ports.send(effect.text, effect.keyboard);
        return undefined;
      case 'edit_keyboard':
        await deps.ports.editKeyboard(effect.messageId, effect.keyboard);
        return undefined;
      case 'answer_callback':
        await deps.ports.answerCallback(effect.text);
        return undefined;
      case 'preview': {
        const shown = await deps.ports.preview(effect.postId);
        if (shown.ok) return undefined;
        // Показ не состоялся: владельцу это событие, а не тишина. Состояние
        // уедет в «пост не прошёл» вместе с причиной.
        return {
          kind: 'pipeline_failed',
          step: 'preview',
          reason: 'preview_failed',
          message: shown.message,
          postId: effect.postId,
          at: new Date().toISOString(),
        };
      }
      case 'item_verdict': {
        const item = deps.store.items.findById(effect.itemId);
        if (item === undefined) {
          deps.logger.warn({ itemId: effect.itemId }, 'решение по несуществующей идее');
          return undefined;
        }
        deps.store.items.markVerdict(effect.itemId, effect.verdict);
        if (effect.verdict === 'offtopic') {
          // Исключение ранжирования: без заголовка запоминать нечего, а
          // адресом такое сравнение не делается.
          deps.store.offtopic.add(item.title ?? item.url);
        }
        return undefined;
      }
      case 'persist': {
        deps.store.posts.patch(effect.postId, effect.patch as PostPatch);
        return undefined;
      }
      case 'decision': {
        // Решение владельца пишется ВСЕГДА с его telegram id: гейт публикации
        // сверяет именно его, а метку «owner» может поставить кто угодно.
        const post = deps.store.posts.get(effect.postId);
        if (post === undefined) {
          deps.logger.warn({ postId: effect.postId, kind: effect.kind }, 'решение по несуществующему посту');
          return undefined;
        }
        recordDecision(effect.postId, effect.kind, effect.textSha, effect.payload);
        return undefined;
      }
      case 'preview_controls': {
        const controls = buildPreviewControls({
          post: deps.store.posts.get(effect.postId),
          postId: effect.postId,
          stamp: effect.stamp,
          channels: deps.channels ?? [],
          note: effect.note,
          config,
        });
        await deps.ports.send(controls.text, controls.keyboard);
        return undefined;
      }
      case 'adopt':
        return adopt(effect);
      case 'schedule_publish':
        deps.ports.schedulePublish(effect.postId, effect.at);
        return undefined;
      case 'cancel_publish':
        deps.ports.cancelPublish(effect.postId);
        return undefined;
      case 'run':
        return deps.ports.runStep(effect.step, effect.args ?? {});
      default:
        return undefined;
    }
  }

  /**
   * Запись решения владельца. Переходы статуса поста делает конвейер, а здесь
   * фиксируется ФАКТ клика — по нему потом проверяется право на публикацию.
   */
  function recordDecision(
    postId: string,
    // Список автомата — подмножество журнала: несоответствие ловит компилятор.
    kind: DecisionEffectKind & DecisionKind,
    textSha?: string,
    payload?: unknown,
  ): void {
    const post = deps.store.posts.get(postId);
    if (post === undefined) return;

    if (kind === 'reject') {
      const result = deps.store.posts.transition({
        id: postId,
        from: ['draft', 'linted', 'reviewed', 'previewed', 'approved', 'handed'],
        to: 'rejected',
        decision: { kind: 'reject', actor: 'owner', actorId: deps.ownerId },
      });
      if (!result.ok) {
        deps.logger.warn({ postId, actual: result.actual }, 'снять пост не удалось');
      }
      return;
    }

    if (kind === 'approve') {
      // Отпечаток из кнопки — ПРЕФИКС; в журнал уходит полный отпечаток поста,
      // иначе гейт публикации не сойдётся никогда.
      const full = post.textSha;
      if (full === undefined || !full.startsWith(textSha ?? '')) {
        deps.logger.warn({ postId }, 'подтверждение не совпало с текстом поста');
        return;
      }
      const result = deps.store.posts.transition({
        id: postId,
        from: ['previewed'],
        to: 'approved',
        // Каналы из кнопки идут в решение: публикация читает их из журнала, а
        // не из поля поста, которое можно перезаписать чем угодно.
        decision: {
          kind: 'approve',
          actor: 'owner',
          actorId: deps.ownerId,
          textSha: full,
          ...(payload === undefined ? {} : { payload }),
        },
      });
      if (!result.ok) deps.logger.warn({ postId, actual: result.actual }, 'подтверждение не состоялось');
      return;
    }

    if (kind === 'threads_posted') {
      // Публикацию на площадке делает человек: бот фиксирует ЕГО слово, и
      // статус двигается только из «отдано владельцу».
      const result = deps.store.posts.transition({
        id: postId,
        from: ['handed'],
        to: 'posted',
        decision: {
          kind: 'threads_posted',
          actor: 'owner',
          actorId: deps.ownerId,
          ...(post.textSha === undefined ? {} : { textSha: post.textSha }),
        },
      });
      if (!result.ok) {
        deps.logger.warn({ postId, actual: result.actual }, 'отметка о публикации в Threads не состоялась');
      }
      return;
    }

    if (kind === 'cancel') {
      const result = deps.store.posts.transition({
        id: postId,
        from: ['approved'],
        to: 'previewed',
        decision: { kind: 'cancel', actor: 'owner', actorId: deps.ownerId },
      });
      if (!result.ok) deps.logger.warn({ postId, actual: result.actual }, 'отмена не состоялась');
      return;
    }

    // Прочие решения (рубрика, угол) — просто строка журнала рядом с постом.
    // Именно строка, а не самопереход статуса: `transition` бросает на
    // переход, не описанный в машине, а на черновике `draft → draft` таким и
    // был — исключение гасило все эффекты после решения, и владелец не
    // получал следующий вопрос.
    deps.store.posts.note(postId, { kind, actor: 'owner', actorId: deps.ownerId, payload });
  }

  /**
   * Кнопка черновика по расписанию: пост становится текущим в диалоге, и
   * нажатие повторяется обычным действием. Сверка — по посту, а не по
   * диалогу: черновик жил вне него.
   */
  async function adopt(effect: Extract<Effect, { type: 'adopt' }>): Promise<DialogEvent | undefined> {
    const post = deps.store.posts.get(effect.postId);
    const platform = post?.platform;
    const waiting = platform === 'threads' ? 'handed' : 'previewed';
    if (
      post === undefined ||
      post.status !== waiting ||
      post.textSha === undefined ||
      !post.textSha.startsWith(effect.stamp)
    ) {
      // Черновик уже опубликован, снят или переписан: кнопка старая.
      await deps.ports.answerCallback(TEXTS.stale);
      if (effect.messageId !== undefined) await deps.ports.editKeyboard(effect.messageId, null);
      return undefined;
    }
    const angles = Array.isArray(post.angles) ? (post.angles as FlowPayload['angles']) : undefined;
    const at = (deps.now ?? ((): Date => new Date()))();
    const state: FlowState = {
      name: platform === 'threads' ? 'threads.previewed' : 'post.previewed',
      postId: post.id,
      payload: {
        platform: platform ?? 'telegram',
        stamp: effect.stamp,
        ...(angles === undefined ? {} : { angles }),
        ...(post.rubric === undefined ? {} : { rubric: post.rubric }),
        ...(post.angle === undefined ? {} : { angle: post.angle, seenAngles: [post.angle] }),
        anglesShown: 1,
      },
      expiresAt: new Date(at.getTime() + config.flow.questionTtlMs).toISOString(),
    };
    write(state);
    deps.logger.info({ postId: post.id, action: effect.action }, 'черновик по расписанию взят в диалог');
    return {
      kind: 'callback',
      data: buildCallback(effect.action, post.id, effect.stamp),
      at: at.toISOString(),
      ...(effect.messageId === undefined ? {} : { messageId: effect.messageId }),
    };
  }

  async function handleOnce(event: DialogEvent, depth: number): Promise<void> {
    if (depth > MAX_CHAIN) {
      deps.logger.error({ depth }, 'цепочка событий диалога не сходится');
      return;
    }

    const state = read();
    const result = transition(state, event, {
      now: event.at,
      questionTtlMs: config.flow.questionTtlMs,
      undoSeconds: deps.undoSeconds,
    });

    deps.logger.info(
      { from: state.name, to: result.state.name, event: event.kind, effects: result.effects.length },
      'переход диалога',
    );

    // Состояние пишется ДО эффектов: шаг конвейера может вернуть событие
    // немедленно, и оно обязано увидеть уже новое состояние.
    write(result.state);

    // Шаг конвейера идёт ПОСЛЕДНИМ, каким бы по счёту его ни поставил автомат.
    // Он живёт минуту и возвращает событие, которое доигрывается здесь же, —
    // поэтому всё, что стоит за ним в списке (в том числе «Собираю»),
    // доезжало до владельца уже ПОСЛЕ готового поста.
    const steps = result.effects.filter((effect) => effect.type === 'run');
    let interrupted: DialogEvent | undefined;
    for (const effect of result.effects) {
      if (effect.type === 'run') continue;
      const next = await applyEffect(effect);
      // Сбой показа доигрывается ПОСЛЕ списка: состояние уже записано, и
      // событие обязано увидеть именно его.
      if (next !== undefined) interrupted = next;
    }
    if (interrupted !== undefined) {
      await handleOnce(interrupted, depth + 1);
      return;
    }
    for (const effect of steps) {
      const next = await applyEffect(effect);
      if (next !== undefined) await handleOnce(next, depth + 1);
    }
  }

  return {
    async handle(event) {
      await handleOnce(event, 0);
    },
    current() {
      return read();
    },
    reset() {
      deps.store.flow.clear(deps.ownerId);
    },
  };
}

export { MAX_CHAIN };
export type { DialogEvent };
