import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { transition } from '../dialog/machine.ts';
import type { DialogEvent, Effect, FlowPayload, FlowState, StateName } from '../dialog/types.ts';
import { STATES } from '../dialog/types.ts';
import type { Logger } from '../logger.ts';
import type { Store } from '../store/index.ts';
import type { DecisionKind } from '../store/post-state.ts';
import type { PostPatch } from '../store/types.ts';
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
        recordDecision(effect.postId, effect.kind as DecisionKind, effect.textSha, effect.payload);
        return undefined;
      }
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
    kind: DecisionKind,
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
        decision: { kind: 'approve', actor: 'owner', actorId: deps.ownerId, textSha: full },
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
