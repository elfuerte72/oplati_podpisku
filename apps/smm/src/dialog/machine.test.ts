import { describe, expect, it } from 'vitest';

import { smmConfig } from '../config/smm.config.ts';
import {
  buildCallback,
  CALLBACK_MAX_BYTES,
  parseCallback,
  stampOf,
  STATES,
  transition,
  TEXTS,
} from './index.ts';
import type {
  DialogEvent,
  Effect,
  FlowState,
  StateName,
  TransitionContext,
} from './types.ts';

const NOW = '2026-09-22T10:00:00.000Z';
const POST_ID = '01JBQ8Z9XK3T0YV8H2M5R7WQ4C';

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return { now: NOW, questionTtlMs: smmConfig.flow.questionTtlMs, undoSeconds: 60, ...overrides };
}

function types(effects: readonly Effect[]): string[] {
  return effects.map((effect) => effect.type);
}

function sends(effects: readonly Effect[]): string[] {
  return effects
    .filter((effect): effect is Extract<Effect, { type: 'send' }> => effect.type === 'send')
    .map((effect) => effect.text);
}

function command(command: string, args = ''): DialogEvent {
  return { kind: 'command', command, args, at: NOW };
}

function text(value: string): DialogEvent {
  return { kind: 'text', text: value, at: NOW };
}

function callback(action: string, id = POST_ID, stamp = 'stamp123', messageId = 42): DialogEvent {
  return { kind: 'callback', data: buildCallback(action, id, stamp), at: NOW, messageId };
}

const ANGLES = [
  { title: 'Память включена всем', idea: 'что изменилось' },
  { title: 'Проверь у себя за минуту', idea: 'что нажать' },
  { title: 'Чем отличается от истории', idea: 'разница' },
];

function previewed(stamp = 'stamp123'): FlowState {
  return {
    name: 'post.previewed',
    postId: POST_ID,
    payload: { stamp, angles: ANGLES, rubric: 'news', anglesShown: 1 },
    expiresAt: '2026-09-23T10:00:00.000Z',
  };
}

describe('команды', () => {
  it('/post со ссылкой сразу запускает разбор источника', () => {
    const result = transition({ name: 'idle' }, command('/post', 'https://example.com/a'), ctx());
    expect(result.state.name).toBe('post.generating');
    expect(types(result.effects)).toEqual(['run', 'send']);
    expect(result.effects[0]).toMatchObject({
      type: 'run',
      step: 'source',
      args: { input: 'https://example.com/a', platform: 'telegram' },
    });
  });

  it('/post без аргументов спрашивает источник и ждёт ТЕКСТ', () => {
    const result = transition({ name: 'idle' }, command('/post'), ctx());
    expect(result.state.name).toBe('post.await_input');
    expect(sends(result.effects)).toEqual([TEXTS.askSource]);
    expect(result.state.expiresAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('/threads помечает площадку в запросе', () => {
    const result = transition({ name: 'idle' }, command('/threads', 'тема'), ctx());
    expect(result.effects[0]).toMatchObject({ args: { platform: 'threads' } });
  });

  it('/cancel из любого состояния снимает пост и возвращает в idle', () => {
    for (const name of STATES) {
      const state: FlowState = { name, postId: name === 'idle' ? undefined : POST_ID };
      const result = transition(state, command('/cancel'), ctx());
      expect(result.state.name, name).toBe('idle');
      if (name !== 'idle') {
        expect(types(result.effects), name).toContain('decision');
      }
    }
  });

  it('/cancel в окне публикации ещё и гасит таймер', () => {
    const state: FlowState = { name: 'post.publish_pending', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(state, command('/cancel'), ctx());
    expect(types(result.effects)).toContain('cancel_publish');
  });

  it('/queue, /stats и /settings отдаются исполнителю без смены состояния', () => {
    for (const [name, step] of [
      ['/queue', 'queue'],
      ['/stats', 'stats'],
      ['/settings', 'settings'],
    ] as const) {
      const state = previewed();
      const result = transition(state, command(name), ctx());
      expect(result.state).toEqual(state);
      expect(result.effects).toEqual([{ type: 'run', step }]);
    }
  });

  it('незнакомая команда получает меню', () => {
    const result = transition({ name: 'idle' }, command('/что-то'), ctx());
    expect(sends(result.effects)).toEqual([TEXTS.menu]);
  });
});

describe('свободный текст', () => {
  it('в состояниях БЕЗ вопроса получает меню и не трогает состояние', () => {
    const silent: StateName[] = [
      'idle',
      'post.await_rubric',
      'post.await_angle',
      'post.previewed',
      'post.await_edit_choice',
      'post.publish_pending',
      'post.failed',
    ];
    for (const name of silent) {
      const state: FlowState = { name, postId: POST_ID, payload: { stamp: 's' } };
      const result = transition(state, text('что-нибудь'), ctx());
      expect(result.state, name).toEqual(state);
      expect(sends(result.effects), name).toEqual([TEXTS.menu]);
    }
  });

  it('во время работы конвейера отвечает «ещё собираю»', () => {
    const state: FlowState = { name: 'post.generating', postId: POST_ID };
    const result = transition(state, text('ну что там'), ctx());
    expect(sends(result.effects)).toEqual([TEXTS.stillWorking]);
    expect(result.state).toEqual(state);
  });

  it('ответ на вопрос об источнике запускает разбор', () => {
    const state: FlowState = { name: 'post.await_input', expiresAt: '2026-09-23T10:00:00.000Z' };
    const result = transition(state, text('https://example.com/a'), ctx());
    expect(result.state.name).toBe('post.generating');
    expect(result.effects[0]).toMatchObject({ step: 'source' });
  });

  it('реплика «что поменять» уходит в круг правок', () => {
    const state: FlowState = { name: 'post.await_edit_text', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(state, text('убери второй абзац'), ctx());
    expect(result.effects[0]).toMatchObject({
      step: 'revise',
      args: { instruction: 'убери второй абзац', postId: POST_ID },
    });
  });

  it('свой текст владельца уходит отдельным шагом', () => {
    const state: FlowState = { name: 'post.await_owner_text', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(state, text('# Мой заголовок\n\nтело'), ctx());
    expect(result.effects[0]).toMatchObject({ step: 'owner_text' });
  });
});

describe('кнопки', () => {
  it('устаревший отпечаток не работает и снимает клавиатуру', () => {
    const state = previewed('stamp123');
    const result = transition(state, callback('pub', POST_ID, 'другой1'), ctx());
    expect(result.state).toEqual(state);
    expect(types(result.effects)).toEqual(['answer_callback', 'edit_keyboard']);
    expect(result.effects[0]).toMatchObject({ text: TEXTS.stale });
    // Решения НЕ записано: клик по старому сообщению не публикует.
    expect(types(result.effects)).not.toContain('decision');
  });

  it('кнопка чужого поста не работает', () => {
    const state = previewed();
    const result = transition(state, callback('pub', 'другой-пост', 'stamp123'), ctx());
    expect(types(result.effects)).toEqual(['answer_callback', 'edit_keyboard']);
  });

  it('кнопка из чужого состояния не работает', () => {
    const state: FlowState = { name: 'post.await_rubric', postId: POST_ID, payload: { stamp: 'stamp123' } };
    const result = transition(state, callback('pub'), ctx());
    expect(types(result.effects)).toEqual(['answer_callback', 'edit_keyboard']);
  });

  it('на КАЖДЫЙ колбэк есть ответ', () => {
    const states: FlowState[] = STATES.map((name) => ({
      name,
      postId: POST_ID,
      payload: { stamp: 'stamp123', angles: ANGLES, candidates: [{ url: 'https://a', title: 'т' }] },
    }));
    for (const state of states) {
      for (const action of ['pub', 'edit', 'angle', 'drop', 'cancel', 'show', 'more', 'ang.0', 'rub.news', 'pick.0']) {
        const result = transition(state, callback(action), ctx());
        expect(types(result.effects)[0], `${state.name}/${action}`).toBe('answer_callback');
      }
    }
  });

  it('битые данные кнопки не роняют автомат', () => {
    const state = previewed();
    for (const data of ['', 'мусор', 'p:pub', 'x:pub:id:stamp', 'p::id:stamp']) {
      const result = transition(state, { kind: 'callback', data, at: NOW, messageId: 1 }, ctx());
      expect(result.state, data).toEqual(state);
      expect(types(result.effects)[0], data).toBe('answer_callback');
    }
  });
});

describe('счастливый путь', () => {
  it('источник прочитан — сразу досье и план, без вопросов', () => {
    const state: FlowState = { name: 'post.generating', expiresAt: '2026-09-23T10:00:00.000Z' };
    const result = transition(
      state,
      { kind: 'pipeline_done', outcome: { kind: 'article', postId: POST_ID, title: 'Заголовок' }, at: NOW },
      ctx(),
    );
    expect(result.state.name).toBe('post.generating');
    expect(result.effects).toEqual([{ type: 'run', step: 'plan', args: { postId: POST_ID } }]);
  });

  it('тема даёт выбор первоисточника кнопками', () => {
    const state: FlowState = { name: 'post.generating' };
    const candidates = [
      { url: 'https://a.example.com/1', title: 'Первый' },
      { url: 'https://b.example.com/2', title: 'Второй' },
    ];
    const result = transition(state, { kind: 'pipeline_done', outcome: { kind: 'candidates', candidates }, at: NOW }, ctx());
    expect(result.state.name).toBe('post.await_source_pick');
    const send = result.effects.find((effect) => effect.type === 'send');
    expect(send?.type === 'send' && send.keyboard?.rows).toHaveLength(3); // два кандидата и «Отменить»
  });

  it('план спрашивает рубрику, предложенная помечена и стоит первой', () => {
    const result = transition(
      { name: 'post.generating', postId: POST_ID },
      {
        kind: 'pipeline_done',
        outcome: { kind: 'plan', postId: POST_ID, rubric: 'howto', angles: ANGLES },
        at: NOW,
      },
      ctx(),
    );
    expect(result.state.name).toBe('post.await_rubric');
    const send = result.effects.find((effect) => effect.type === 'send');
    const rows = send?.type === 'send' ? (send.keyboard?.rows ?? []) : [];
    expect(rows).toHaveLength(5);
    expect(rows[0]?.[0]?.text).toBe('✓ Как этим пользоваться');
  });

  it('выбор рубрики ведёт к выбору угла', () => {
    const stamp = stampOf({ rubric: 'news', angles: ANGLES });
    const state: FlowState = {
      name: 'post.await_rubric',
      postId: POST_ID,
      payload: { stamp, angles: ANGLES, rubric: 'news', anglesShown: 1 },
    };
    const result = transition(state, callback('rub.price', POST_ID, stamp), ctx());
    expect(result.state.name).toBe('post.await_angle');
    expect(result.state.payload?.rubric).toBe('price');
    expect(types(result.effects)).toContain('persist');
    expect(types(result.effects)).toContain('decision');
  });

  it('выбор угла запускает написание поста', () => {
    const stamp = stampOf({ angles: ANGLES, rubric: 'news' });
    const state: FlowState = {
      name: 'post.await_angle',
      postId: POST_ID,
      payload: { stamp, angles: ANGLES, rubric: 'news', anglesShown: 1 },
    };
    const result = transition(state, callback('ang.1', POST_ID, stamp), ctx());
    expect(result.state.name).toBe('post.generating');
    expect(result.effects.find((e) => e.type === 'run')).toMatchObject({
      step: 'produce',
      args: { postId: POST_ID, rubric: 'news', angle: 'Проверь у себя за минуту' },
    });
  });

  it('«Другие углы» даются один раз', () => {
    const stamp = stampOf({ angles: ANGLES, rubric: 'news' });
    const first: FlowState = {
      name: 'post.await_angle',
      postId: POST_ID,
      payload: { stamp, angles: ANGLES, rubric: 'news', anglesShown: 1 },
    };
    const again = transition(first, callback('more', POST_ID, stamp), ctx());
    expect(again.effects.find((e) => e.type === 'run')).toMatchObject({ step: 'angles' });

    const second: FlowState = { ...first, payload: { ...first.payload, anglesShown: 2 } };
    const denied = transition(second, callback('more', POST_ID, stamp), ctx());
    expect(denied.effects[0]).toMatchObject({ text: TEXTS.stale });
  });

  it('готовый пост показывается превью', () => {
    const result = transition(
      { name: 'post.generating', postId: POST_ID },
      {
        kind: 'pipeline_done',
        outcome: { kind: 'post', postId: POST_ID, textSha: 'abcdef1234567890', verdict: 'pass' },
        at: NOW,
      },
      ctx(),
    );
    expect(result.state.name).toBe('post.previewed');
    expect(result.state.payload?.stamp).toBe('abcdef12');
    expect(result.effects).toEqual([{ type: 'preview', postId: POST_ID }]);
  });

  it('не прошедший проверку пост показывает оценку и две кнопки', () => {
    const result = transition(
      { name: 'post.generating', postId: POST_ID },
      {
        kind: 'pipeline_done',
        outcome: {
          kind: 'post',
          postId: POST_ID,
          textSha: 'abcdef1234567890',
          verdict: 'fail',
          summary: 'Редактор: 3.4/5',
        },
        at: NOW,
      },
      ctx(),
    );
    expect(result.state.name).toBe('post.failed');
    const send = result.effects.find((effect) => effect.type === 'send');
    expect(send?.type === 'send' && send.text).toContain('3.4/5');
    expect(send?.type === 'send' && send.keyboard?.rows).toHaveLength(2);
  });

  it('«Показать как есть» возвращает превью', () => {
    const state: FlowState = { name: 'post.failed', postId: POST_ID, payload: { stamp: 'abcdef12' } };
    const result = transition(state, callback('show', POST_ID, 'abcdef12'), ctx());
    expect(result.state.name).toBe('post.previewed');
    expect(types(result.effects)).toContain('preview');
  });
});

describe('публикация и окно отмены', () => {
  it('«Опубликовать» пишет решение с отпечатком и ставит таймер', () => {
    const state = previewed('abcdef12');
    const result = transition(state, callback('pub', POST_ID, 'abcdef12'), ctx());
    expect(result.state.name).toBe('post.publish_pending');
    const decision = result.effects.find((effect) => effect.type === 'decision');
    expect(decision).toMatchObject({ kind: 'approve', textSha: 'abcdef12' });
    const schedule = result.effects.find((effect) => effect.type === 'schedule_publish');
    expect(schedule).toMatchObject({ postId: POST_ID, at: '2026-09-22T10:01:00.000Z' });
    expect(sends(result.effects)[0]).toContain('60');
  });

  it('«Отменить» возвращает превью и гасит таймер', () => {
    const state: FlowState = {
      name: 'post.publish_pending',
      postId: POST_ID,
      payload: { stamp: 'abcdef12', publishAt: '2026-09-22T10:01:00.000Z' },
    };
    const result = transition(state, callback('cancel', POST_ID, 'abcdef12'), ctx());
    expect(result.state.name).toBe('post.previewed');
    expect(types(result.effects)).toContain('cancel_publish');
    expect(result.effects.find((e) => e.type === 'persist')).toMatchObject({
      patch: { publishAt: null },
    });
  });

  it('срабатывание таймера публикует', () => {
    const state: FlowState = { name: 'post.publish_pending', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(state, { kind: 'timer_fired', postId: POST_ID, at: NOW }, ctx());
    expect(result.state.name).toBe('idle');
    expect(result.effects).toEqual([{ type: 'run', step: 'publish', args: { postId: POST_ID } }]);
  });

  it('таймер чужого или отменённого поста не публикует', () => {
    const cancelled = previewed();
    expect(transition(cancelled, { kind: 'timer_fired', postId: POST_ID, at: NOW }, ctx()).effects).toEqual([]);

    const other: FlowState = { name: 'post.publish_pending', postId: POST_ID, payload: { stamp: 's' } };
    expect(transition(other, { kind: 'timer_fired', postId: 'другой', at: NOW }, ctx()).effects).toEqual([]);
  });

  it('окно отмены не истекает по сроку вопроса', () => {
    // 24 часа ожидания ответа к публикации отношения не имеют: таймер свой.
    const state: FlowState = {
      name: 'post.publish_pending',
      postId: POST_ID,
      payload: { stamp: 'abcdef12' },
      expiresAt: '2026-09-22T09:00:00.000Z',
    };
    const result = transition(state, callback('cancel', POST_ID, 'abcdef12'), ctx());
    expect(result.state.name).toBe('post.previewed');
  });
});

describe('истечение вопроса', () => {
  it('текст после суток молчания получает подсказку, а состояние сбрасывается', () => {
    const state: FlowState = {
      name: 'post.await_edit_text',
      postId: POST_ID,
      payload: { stamp: 's' },
      expiresAt: '2026-09-21T10:00:00.000Z',
    };
    const result = transition(state, text('вот правка'), ctx());
    expect(result.state.name).toBe('idle');
    expect(sends(result.effects)).toEqual([TEXTS.expired]);
  });

  it('кнопка после истечения не работает', () => {
    const state: FlowState = {
      name: 'post.previewed',
      postId: POST_ID,
      payload: { stamp: 'abcdef12' },
      expiresAt: '2026-09-21T10:00:00.000Z',
    };
    const result = transition(state, callback('pub', POST_ID, 'abcdef12'), ctx());
    expect(result.state.name).toBe('idle');
    expect(types(result.effects)).not.toContain('decision');
  });

  it('команда после истечения работает как обычно', () => {
    const state: FlowState = {
      name: 'post.await_input',
      expiresAt: '2026-09-21T10:00:00.000Z',
    };
    const result = transition(state, command('/post', 'https://example.com/a'), ctx());
    expect(result.state.name).toBe('post.generating');
  });

  it('событие истечения снимает незавершённый пост', () => {
    const state: FlowState = { name: 'post.await_angle', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(state, { kind: 'expired', at: NOW }, ctx());
    expect(result.state.name).toBe('idle');
    expect(types(result.effects)).toEqual(['decision']);
  });
});

describe('провал шага', () => {
  it('приносит причину и кнопки «показать» или «снять»', () => {
    const state: FlowState = { name: 'post.generating', postId: POST_ID, payload: { stamp: 'abcdef12' } };
    const result = transition(
      state,
      { kind: 'pipeline_failed', step: 'produce', reason: 'model_failed', message: 'провайдер молчит', at: NOW },
      ctx(),
    );
    expect(result.state.name).toBe('post.failed');
    expect(sends(result.effects)[0]).toContain('провайдер молчит');
  });

  it('«ничего не меняется» приходит как провал шага плана', () => {
    const state: FlowState = { name: 'post.generating', postId: POST_ID, payload: { stamp: 's' } };
    const result = transition(
      state,
      {
        kind: 'pipeline_failed',
        step: 'plan',
        reason: 'nothing_changes',
        message: 'функция уже была у всех',
        at: NOW,
      },
      ctx(),
    );
    expect(sends(result.effects)[0]).toContain('функция уже была у всех');
  });

  it('провал без поста возвращает в idle', () => {
    const result = transition(
      { name: 'post.generating' },
      { kind: 'pipeline_failed', step: 'source', reason: 'http_error', message: 'страница не открылась', at: NOW },
      ctx(),
    );
    expect(result.state.name).toBe('idle');
  });
});

describe('данные кнопок', () => {
  it('влезают в лимит Telegram', () => {
    const data = buildCallback('rub.howto', POST_ID, 'abcdef12');
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    expect(parseCallback(data)).toEqual({ action: 'rub.howto', id: POST_ID, stamp: 'abcdef12' });
  });

  it('слишком длинные данные — ошибка кода, а не молчаливый отказ Telegram', () => {
    expect(() => buildCallback('очень-длинное-действие'.repeat(3), POST_ID, 'abcdef12')).toThrowError(
      /длиннее/,
    );
  });

  it('отпечаток вопроса меняется вместе с вариантами', () => {
    expect(stampOf(ANGLES)).not.toBe(stampOf([...ANGLES].reverse()));
    expect(stampOf(ANGLES)).toBe(stampOf(ANGLES));
  });
});
