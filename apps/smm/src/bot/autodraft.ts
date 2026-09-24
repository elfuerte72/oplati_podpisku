import { z } from 'zod';

import type { ChannelTarget } from '../config/env.ts';
import { smmConfig, type SmmConfig } from '../config/smm.config.ts';
import { AUTO_PREFIX } from '../dialog/keyboards.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { AngleOption, DialogEvent, Keyboard, Platform } from '../dialog/types.ts';
import type { Logger } from '../logger.ts';
import type { Store } from '../store/index.ts';
import { buildPreviewControls } from './channels.ts';
import { rankedIdeas } from './ideas-view.ts';
import type { Runner } from './runner.ts';
import { mskDay, mskHour } from './ticker.ts';

/**
 * Черновики по расписанию: бот сам берёт лучшую идею из источников, пишет пост
 * и присылает владельцу готовое превью с кнопками.
 *
 * ⚠️ Черновик НЕ трогает диалог владельца (`flow`): он приходит отдельным
 * сообщением, а его кнопки несут префикс `a.` и называют пост сами. Нажатие
 * «усыновляет» пост в диалог (`adopt` в движке). Иначе черновик, пришедший
 * посреди правок другого поста, обрывал бы их и делал кнопки того поста
 * устаревшими.
 *
 * Публикует по-прежнему ТОЛЬКО владелец кнопкой: расписание пишет, а не выкладывает.
 */

export interface AutodraftDeps {
  readonly store: Store;
  readonly runner: Pick<Runner, 'runStep' | 'preview'>;
  /** Сообщение владельцу: подпись и кнопки под превью, короткие уведомления. */
  readonly send: (text: string, keyboard?: Keyboard) => Promise<unknown>;
  readonly logger: Logger;
  readonly channels: readonly ChannelTarget[];
  readonly config?: SmmConfig;
  readonly now?: () => Date;
}

export type AutodraftResult =
  | { readonly kind: 'sent'; readonly postId: string; readonly itemId: string; readonly verdict: 'pass' | 'fail' }
  | { readonly kind: 'skipped'; readonly reason: 'too_many_pending' | 'no_idea' }
  | { readonly kind: 'failed'; readonly step: string; readonly message: string; readonly postId?: string };

type Done = Extract<DialogEvent, { kind: 'pipeline_done' }>;
type OutcomeOf<K extends Done['outcome']['kind']> = Extract<Done['outcome'], { kind: K }>;

/** Исход шага, если это ожидаемый итог; иначе — причина сбоя. */
function outcomeOf<K extends Done['outcome']['kind']>(
  event: DialogEvent | undefined,
  kind: K,
): { ok: true; outcome: OutcomeOf<K> } | { ok: false; reason: string; message: string } {
  if (event === undefined) return { ok: false, reason: 'no_event', message: 'шаг ничего не вернул' };
  if (event.kind === 'pipeline_failed') return { ok: false, reason: event.reason, message: event.message };
  if (event.kind !== 'pipeline_done' || event.outcome.kind !== kind) {
    const got = event.kind === 'pipeline_done' ? event.outcome.kind : event.kind;
    return { ok: false, reason: 'unexpected', message: `шаг вернул ${got}` };
  }
  return { ok: true, outcome: event.outcome as OutcomeOf<K> };
}

/** Угол черновика: с действием для читателя, иначе первый. Советует план, выбирает код. */
export function pickAngle(angles: readonly AngleOption[]): AngleOption | undefined {
  return angles.find((angle) => angle.readerAction === true) ?? angles[0];
}

/** Один черновик площадки. Никогда не бросает: исход — данными. */
export async function runAutodraft(
  platform: Platform,
  slot: string,
  deps: AutodraftDeps,
): Promise<AutodraftResult> {
  const config = deps.config ?? smmConfig;

  // Потолок неразобранных: если владелец не успевает, новые черновики только
  // копятся и стоят денег.
  if (deps.store.posts.countPendingAuto(platform) >= config.autodraft.maxPending) {
    return { kind: 'skipped', reason: 'too_many_pending' };
  }

  const idea = rankedIdeas(deps.store, {
    config,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }).find((candidate) => (candidate.relevance ?? 0) >= config.autodraft.minRelevance);
  if (idea === undefined) return { kind: 'skipped', reason: 'no_idea' };
  const itemId = idea.item.id;

  // Идею занимает САМ шаг источника — тем же условным UPDATE, что и кнопка
  // «Написать»: две точки занятия разошлись бы, и тема писалась бы дважды.
  const source = outcomeOf(await deps.runner.runStep('source', { itemId, platform, origin: 'auto' }), 'article');
  if (!source.ok) {
    if (source.reason === 'idea_taken') return { kind: 'skipped', reason: 'no_idea' };
    return { kind: 'failed', step: 'source', message: source.message };
  }
  const postId = source.outcome.postId;

  // Сборка, сорвавшаяся после создания поста, хоронит пост: брошенный черновик
  // висел бы в /queue, и владелец разбирал бы чужой мусор.
  const abandon = (step: string, message: string): AutodraftResult => {
    const moved = deps.store.posts.transition({
      id: postId,
      from: ['draft', 'linted', 'reviewed'],
      to: 'rejected',
      decision: { kind: 'reject', actor: 'code', payload: { auto: true, step, reason: message } },
    });
    if (!moved.ok) deps.logger.warn({ postId, actual: moved.actual }, 'несобранный черновик не снялся');
    return { kind: 'failed', step, message, postId };
  };

  const planned = outcomeOf(await deps.runner.runStep('plan', { postId }), 'plan');
  if (!planned.ok) return abandon('plan', planned.message);
  const angle = pickAngle(planned.outcome.angles);
  if (angle === undefined) return abandon('plan', 'план без углов');
  // Выбор рубрики и угла — след в журнале: их сделал код, а не владелец.
  deps.store.posts.note(postId, { kind: 'rubric', actor: 'code', payload: { rubric: planned.outcome.rubric, auto: true } });
  deps.store.posts.note(postId, { kind: 'angle', actor: 'code', payload: { angle: angle.title, auto: true } });

  const produced = outcomeOf(
    await deps.runner.runStep('produce', { postId, rubric: planned.outcome.rubric, angle: angle.title, noAds: true }),
    'post',
  );
  if (!produced.ok) return abandon('produce', produced.message);

  const failedCheck =
    produced.outcome.verdict === 'fail' && produced.outcome.summary !== undefined
      ? `\nПроверку не прошёл:\n${produced.outcome.summary}`
      : '';

  if (platform === 'threads') {
    // У площадки кнопки живут на самом посте (экран передачи). Подпись — ПОСЛЕ
    // него: отправленная до превью, она противоречила бы сорвавшемуся показу.
    const shown = await deps.runner.preview(postId, { prefix: AUTO_PREFIX });
    if (!shown.ok) return abandon('preview', shown.message);
    await deps.send(`${TEXTS.autoDraftReady('threads', slot)}${failedCheck}`);
    return { kind: 'sent', postId, itemId, verdict: produced.outcome.verdict };
  }

  const shown = await deps.runner.preview(postId);
  if (!shown.ok) return abandon('preview', shown.message);
  const post = deps.store.posts.get(postId);
  const controls = buildPreviewControls({
    post,
    postId,
    stamp: (post?.textSha ?? produced.outcome.textSha).slice(0, 8),
    channels: deps.channels,
    note: 'ready',
    prefix: AUTO_PREFIX,
    headline: `${TEXTS.autoDraftReady('telegram', slot)}${failedCheck}`,
    config,
  });
  try {
    await deps.send(controls.text, controls.keyboard);
  } catch (error) {
    // Превью уже у владельца, а кнопок к нему нет. Пост цел и лежит в /queue —
    // это не «не собрался», и говорить надо ровно это.
    deps.logger.warn({ err: error, postId }, 'кнопки черновика не дошли');
    return { kind: 'failed', step: 'controls', message: 'превью ушло без кнопок, черновик ждёт в /queue', postId };
  }
  return { kind: 'sent', postId, itemId, verdict: produced.outcome.verdict };
}

// ------------------------------------------------------------------ расписание

export const SETTINGS_AUTODRAFT_ENABLED = 'autodraft.enabled';
const SLOT_PREFIX = 'autodraft.slot.';
const PENDING_NOTICE_PREFIX = 'autodraft.pendingNotice.';
export const AutodraftEnabled = z.boolean();
const SlotMark = z.object({ at: z.string(), outcome: z.string() });
const NoticeMark = z.string();

/** Ключ слота: площадка, день и час по Москве. Слот срабатывает один раз. */
export function slotKey(platform: Platform, at: Date, hour: number): string {
  return `${SLOT_PREFIX}${platform}.${mskDay(at)}.${hour}`;
}

export type SlotDecision =
  | { readonly kind: 'run'; readonly hour: number; readonly key: string }
  | { readonly kind: 'late'; readonly hour: number; readonly key: string }
  | { readonly kind: 'none' };

/**
 * Какой слот площадки пора отработать сейчас. Берётся ПОСЛЕДНИЙ наступивший и
 * ещё не отработанный: после простоя два пропущенных слота не присылают два
 * черновика разом. Слот, опоздавший дольше `lateHours`, помечается пропущенным.
 */
export function dueSlot(
  platform: Platform,
  at: Date,
  isDone: (key: string) => boolean,
  config: SmmConfig = smmConfig,
): SlotDecision {
  const hour = mskHour(at);
  const passed = [...config.autodraft.slotsMsk[platform]].filter((slot) => slot <= hour).sort((a, b) => b - a);
  const latest = passed[0];
  if (latest === undefined) return { kind: 'none' };
  const key = slotKey(platform, at, latest);
  if (isDone(key)) return { kind: 'none' };
  if (hour - latest >= config.autodraft.lateHours) return { kind: 'late', hour: latest, key };
  return { kind: 'run', hour: latest, key };
}

export interface AutodraftScheduler {
  start(): void;
  stop(): void;
  /** Один проход — для тестов и ручного запуска. */
  tick(): Promise<void>;
}

export function createAutodraftScheduler(
  deps: AutodraftDeps & {
    /** Сколько ждать между проверками; по умолчанию из конфига. */
    readonly everyMs?: number;
  },
): AutodraftScheduler {
  const config = deps.config ?? smmConfig;
  const now = deps.now ?? ((): Date => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const isDone = (key: string): boolean => deps.store.settings.get(key, SlotMark) !== undefined;
  const mark = (key: string, outcome: string): void => {
    deps.store.settings.set(key, SlotMark, { at: now().toISOString(), outcome });
  };

  /** Ключи прошлых дней не нужны никому: читаются только ключи сегодняшнего. */
  function prune(at: Date): void {
    const today = mskDay(at);
    for (const key of deps.store.settings.keys()) {
      const isSlot = key.startsWith(SLOT_PREFIX);
      const isNotice = key.startsWith(PENDING_NOTICE_PREFIX);
      if ((isSlot || isNotice) && !key.includes(`.${today}`)) deps.store.settings.remove(key);
    }
  }

  async function notify(text: string): Promise<void> {
    await deps.send(text).catch((error: unknown) => {
      deps.logger.warn({ err: error }, 'сообщение о черновике по расписанию не ушло');
    });
  }

  async function tick(): Promise<void> {
    // Проход не наслаивается на проход: черновик пишется минутами.
    if (running) return;
    const enabled = deps.store.settings.get(SETTINGS_AUTODRAFT_ENABLED, AutodraftEnabled) ?? true;
    if (!enabled) return;
    running = true;
    try {
      prune(now());
      for (const platform of ['telegram', 'threads'] as const) {
        const at = now();
        const decision = dueSlot(platform, at, isDone, config);
        if (decision.kind === 'none') continue;
        if (decision.kind === 'late') {
          mark(decision.key, 'late');
          deps.logger.info({ platform, hour: decision.hour }, 'слот черновика пропущен: опоздал');
          continue;
        }
        // Слот занимается ДО прогона: сбой посреди прогона не повторяется
        // платно в тот же слот и не присылает второй черновик после перезапуска.
        mark(decision.key, 'started');
        const slot = `${String(decision.hour).padStart(2, '0')}:00`;
        const result = await runAutodraft(platform, slot, deps).catch((error: unknown) => ({
          kind: 'failed' as const,
          step: 'crash',
          message: error instanceof Error ? error.message : String(error),
        }));
        mark(decision.key, result.kind === 'skipped' ? `skipped:${result.reason}` : result.kind);
        deps.logger.info({ platform, slot, result }, 'черновик по расписанию');
        if (result.kind === 'failed') {
          // Владелец ждёт черновик в это время: молчать нельзя.
          const reason = result.step === 'controls' ? result.message : `не собрался — ${result.message}`;
          await notify(TEXTS.autoDraftFailed(platform, slot, reason));
        }
        if (result.kind === 'skipped' && result.reason === 'too_many_pending') {
          // Упёрлись в потолок — черновики встали, пока владелец не разберёт
          // очередь. Сказать об этом раз в день: иначе остановка выглядит как тишина.
          const noticeKey = `${PENDING_NOTICE_PREFIX}${platform}.${mskDay(at)}`;
          if (deps.store.settings.get(noticeKey, NoticeMark) === undefined) {
            deps.store.settings.set(noticeKey, NoticeMark, at.toISOString());
            await notify(TEXTS.autoDraftPaused(platform, config.autodraft.maxPending));
          }
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      const every = deps.everyMs ?? config.autodraft.checkEveryMinutes * 60 * 1000;
      timer = setInterval(() => {
        void tick();
      }, every);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
