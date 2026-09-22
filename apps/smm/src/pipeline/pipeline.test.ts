import { describe, expect, it } from 'vitest';

import { smmConfig } from '../config/smm.config.ts';
import { createLogger } from '../logger.ts';
import type { Model, ModelResult } from '../llm/model.ts';
import type { ModelRole } from '../config/smm.config.ts';
import { advise, advisePlan, buildDossier, plan, producePost, review, revisePost, trimArticle } from './index.ts';
import { threadsBody } from './threads.ts';
import { reviseInput } from './inputs.ts';
import { lintThreads } from '../lint/threads.ts';
import {
  DOSSIER,
  DRAFT_WITH_LINT_ERROR,
  GOOD_DRAFT,
  HISTORY,
  judgeFail,
  judgePass,
  PLAN_ANSWER,
  PLAN_NOTHING_CHANGES,
} from './fixtures.ts';
import type { Brief, HistoryPost, PipelineDeps, ReviewContext } from './types.ts';

/** Модель-фикстура: ответы задаёт тест по ролям, вызовы записываются. */
function fakeModel(
  answers: Partial<Record<ModelRole, unknown[]>>,
): { model: Model; calls: { role: ModelRole; input: string }[] } {
  const queues = new Map<ModelRole, unknown[]>(
    Object.entries(answers).map(([role, list]) => [role as ModelRole, [...(list ?? [])]]),
  );
  const calls: { role: ModelRole; input: string }[] = [];

  function next(role: ModelRole): ModelResult<never> {
    const queue = queues.get(role);
    const value = queue === undefined || queue.length === 0 ? undefined : queue.shift();
    if (value === undefined) {
      return { ok: false, reason: 'api_error', message: `фикстура для роли ${role} кончилась` };
    }
    if (value instanceof Error) {
      return { ok: false, reason: 'api_error', message: value.message };
    }
    return { ok: true, value: value as never };
  }

  const model: Model = {
    json(role, input) {
      calls.push({ role, input });
      return Promise.resolve(next(role));
    },
    markdown(role, input) {
      calls.push({ role, input });
      return Promise.resolve(next(role) as ModelResult<string>);
    },
  };
  return { model, calls };
}

function deps(model: Model): PipelineDeps {
  return { model, logger: createLogger({ level: 'fatal', stream: { write() {} } }) };
}

function reviewCtx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    platform: 'telegram',
    rubric: 'news',
    layout: 'a',
    cta: 'none',
    hasImage: true,
    dossier: DOSSIER,
    ...overrides,
  };
}

describe('советник', () => {
  it('уровень рекламы берётся из рубрики', () => {
    expect(advise({ rubric: 'news' }).cta).toBe('none');
    expect(advise({ rubric: 'price' }).cta).toBe('soft');
  });

  it('дефицит рубрик считается по истории', () => {
    // Десять постов новостей: рубрика «Сколько стоит и стоит ли» в дефиците.
    const history = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      rubric: 'news' as const,
      cta: 'none' as const,
      body: '# Пост\n\nтело',
    }));
    const result = advise({ rubric: 'news', history });
    expect(result.rubricDeficit.join(' ')).toContain('Сколько стоит и стоит ли');
    expect(result.text).toContain('Дефицит рубрик');
  });

  it('два hard подряд невозможны: уровень снижается до soft', () => {
    const history = [
      { id: 'p1', rubric: 'price' as const, cta: 'hard' as const, body: '# Пост\n\nтело' },
      { id: 'p2', rubric: 'price' as const, cta: 'hard' as const, body: '# Пост\n\nтело' },
    ];
    // Рубрика с hard по умолчанию — берём конфиг с таким уровнем.
    const config = {
      ...smmConfig,
      rubrics: { ...smmConfig.rubrics, price: { ...smmConfig.rubrics.price, cta: 'hard' as const } },
    };
    const result = advise({ rubric: 'price', history, config });
    expect(result.cta).toBe('soft');
    expect(result.ctaReasons.join(' ')).toContain('два последних поста');
  });

  it('доля явной рекламы выше потолка снижает уровень', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      rubric: 'price' as const,
      cta: (i % 2 === 0 ? 'hard' : 'none') as 'hard' | 'none',
      body: '# Пост\n\nтело',
    }));
    const config = {
      ...smmConfig,
      rubrics: { ...smmConfig.rubrics, price: { ...smmConfig.rubrics.price, cta: 'hard' as const } },
    };
    // Первые два не подряд hard, но доля 50% выше потолка 40%.
    const shuffled = [history[1]!, ...history.slice(2), history[0]!];
    const result = advise({ rubric: 'price', history: shuffled, config });
    expect(result.cta).toBe('soft');
    expect(result.ctaReasons.join(' ')).toContain('потолок');
  });

  it('речь о платной подписке поднимает none до soft', () => {
    expect(advise({ rubric: 'news', aboutPaidService: true }).cta).toBe('soft');
  });

  it('список «не повторять» собирает зачины и связки истории', () => {
    const result = advise({ rubric: 'news', history: HISTORY });
    const text = result.doNotRepeat.join(' ');
    expect(text).toContain('зачины заголовков');
    expect(text).toContain('если коротко');
    expect(result.text).toContain('Не повторять');
  });

  it('без истории советник молчит, но уровень даёт', () => {
    const result = advise({ rubric: 'news', history: [] });
    expect(result.rubricDeficit).toEqual([]);
    expect(result.doNotRepeat).toEqual([]);
    expect(result.cta).toBe('none');
  });
});

describe('досье', () => {
  it('собирается по статье и уходит наверх', async () => {
    const { model, calls } = fakeModel({ dossier: [DOSSIER] });
    const result = await buildDossier(
      { url: 'https://example.com/a', title: 'Заголовок', text: 'т'.repeat(500) },
      deps(model),
    );
    expect(result).toEqual({ ok: true, value: DOSSIER });
    expect(calls[0]?.role).toBe('dossier');
    expect(calls[0]?.input).toContain('Адрес статьи: https://example.com/a');
  });

  it('пустая статья не идёт в модель вовсе', async () => {
    const { model, calls } = fakeModel({ dossier: [DOSSIER] });
    const result = await buildDossier({ url: 'https://example.com/a', title: 'т', text: 'коротко' }, deps(model));
    expect(result).toMatchObject({ ok: false, reason: 'empty_source' });
    expect(calls).toEqual([]);
  });

  it('провал модели поднимается как model_failed', async () => {
    const { model } = fakeModel({ dossier: [new Error('сеть отвалилась')] });
    const result = await buildDossier(
      { url: 'https://example.com/a', title: 'т', text: 'т'.repeat(500) },
      deps(model),
    );
    expect(result).toMatchObject({ ok: false, reason: 'model_failed' });
  });

  it('длинная статья обрезается с сохранением начала и конца', () => {
    const text = `НАЧАЛО${'x'.repeat(20_000)}КОНЕЦ`;
    const trimmed = trimArticle(text, 1000);
    expect(trimmed.startsWith('НАЧАЛО')).toBe(true);
    expect(trimmed.endsWith('КОНЕЦ')).toBe(true);
    expect(trimmed).toContain('середина статьи опущена');
    expect(trimmed.length).toBeLessThan(1200);
  });
});

describe('план', () => {
  it('отдаёт рубрику и три угла', async () => {
    const { model } = fakeModel({ plan: [PLAN_ANSWER] });
    const result = await plan({ dossier: DOSSIER }, deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.angles).toHaveLength(3);
    expect(result.value.angles.some((angle) => angle.reader_action)).toBe(true);
  });

  it('«ничего не меняется» поднимается наверх БЕЗ вызова автора', async () => {
    const { model, calls } = fakeModel({ plan: [PLAN_NOTHING_CHANGES] });
    const result = await plan({ dossier: DOSSIER }, deps(model));
    expect(result).toMatchObject({ ok: false, reason: 'nothing_changes' });
    expect(calls.map((call) => call.role)).toEqual(['plan']);
  });

  it('совет советника уходит в запрос как правило', async () => {
    const { model, calls } = fakeModel({ plan: [PLAN_ANSWER] });
    const hint = advise({ rubric: 'news', history: HISTORY });
    await plan({ dossier: DOSSIER, advice: hint }, deps(model));
    expect(calls[0]?.input).toContain('это правило, а не подсказка');
    expect(calls[0]?.input).toContain('Не повторять');
  });

  it('уже показанные углы попадают в запрос «другие углы»', async () => {
    const { model, calls } = fakeModel({ plan: [PLAN_ANSWER] });
    await plan({ dossier: DOSSIER, seenAngles: ['Память Gemini включена всем'] }, deps(model));
    expect(calls[0]?.input).toContain('владелец уже видел');
  });
});

describe('проверка черновика', () => {
  it('годный черновик проходит линт и редактора без кругов', async () => {
    const { model, calls } = fakeModel({ judge: [judgePass()] });
    const result = await review(GOOD_DRAFT, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(result.value.rounds).toBe(0);
    expect(calls.map((call) => call.role)).toEqual(['judge']);
  });

  it('круг правок по линту запускается РОВНО один раз', async () => {
    const { model, calls } = fakeModel({
      revise: [GOOD_DRAFT],
      judge: [judgePass()],
    });
    const result = await review(DRAFT_WITH_LINT_ERROR, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(result.value.rounds).toBe(1);
    expect(calls.filter((call) => call.role === 'revise')).toHaveLength(1);
    // В круг правок уходит отчёт линта, а не просто «перепиши».
    expect(calls[0]?.input).toContain('ОШИБКА');
  });

  it('второй провал линта уходит владельцу, а не в третий круг', async () => {
    const { model, calls } = fakeModel({ revise: [DRAFT_WITH_LINT_ERROR] });
    const result = await review(DRAFT_WITH_LINT_ERROR, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('fail');
    expect(result.value.failedBy).toBe('lint');
    // Судью не звали: линт до него не пустил.
    expect(calls.some((call) => call.role === 'judge')).toBe(false);
  });

  it('судья зовётся ПОСЛЕ каждого круга правок', async () => {
    const { model, calls } = fakeModel({
      judge: [judgeFail(), judgeFail(), judgePass()],
      revise: [GOOD_DRAFT, GOOD_DRAFT],
    });
    const result = await review(GOOD_DRAFT, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(result.value.rounds).toBe(2);
    expect(calls.map((call) => call.role)).toEqual(['judge', 'revise', 'judge', 'revise', 'judge']);
  });

  it('после двух кругов FAIL результат fail с ПОСЛЕДНЕЙ оценкой', async () => {
    const { model } = fakeModel({
      judge: [judgeFail(), judgeFail(), judgeFail()],
      revise: [GOOD_DRAFT, GOOD_DRAFT],
    });
    const result = await review(GOOD_DRAFT, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('fail');
    expect(result.value.failedBy).toBe('judge');
    expect(result.value.judge?.verdict).toBe('fail');
    expect(result.value.rounds).toBe(2);
  });

  it('заметки судьи уходят в круг правок вместе с цитатами', async () => {
    const { model, calls } = fakeModel({ judge: [judgeFail(), judgePass()], revise: [GOOD_DRAFT] });
    await review(GOOD_DRAFT, reviewCtx(), deps(model));
    const revision = calls.find((call) => call.role === 'revise');
    expect(revision?.input).toContain('Проверить можно за минуту');
    expect(revision?.input).toContain('живой детали');
  });

  it('сбой модели на круге правок отдаёт последнюю оценку, а не теряет пост', async () => {
    const { model } = fakeModel({ judge: [judgeFail()], revise: [new Error('провайдер лёг')] });
    const result = await review(GOOD_DRAFT, reviewCtx(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('fail');
    expect(result.value.judge?.mean).toBeGreaterThan(0);
  });

  it('сбой модели у судьи поднимается как model_failed', async () => {
    const { model } = fakeModel({ judge: [new Error('таймаут')] });
    const result = await review(GOOD_DRAFT, reviewCtx(), deps(model));
    expect(result).toMatchObject({ ok: false, reason: 'model_failed' });
  });

  it('текст владельца минует судью', async () => {
    const { model, calls } = fakeModel({});
    const result = await review(GOOD_DRAFT, reviewCtx({ ownerText: true }), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(calls).toEqual([]);
  });

  it('текст владельца всё равно проходит линт — но модель его НЕ переписывает', async () => {
    const { model, calls } = fakeModel({ revise: [DRAFT_WITH_LINT_ERROR] });
    const result = await review(DRAFT_WITH_LINT_ERROR, reviewCtx({ ownerText: true }), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('fail');
    expect(result.value.failedBy).toBe('lint');
    // Текст остался тем же, что прислал владелец: круга правок не было.
    expect(result.value.body).toBe(DRAFT_WITH_LINT_ERROR);
    expect(calls).toEqual([]);
  });
});

describe('счастливый путь', () => {
  function brief(overrides: Partial<Brief> = {}): Brief {
    return {
      platform: 'telegram',
      dossier: DOSSIER,
      rubric: 'news',
      angle: 'Проверь память в своём аккаунте',
      hasImage: true,
      history: HISTORY,
      ...overrides,
    };
  }

  it('советник, автор, проверка — в этом порядке', async () => {
    const { model, calls } = fakeModel({ write: [GOOD_DRAFT], judge: [judgePass()] });
    const result = await producePost(brief(), deps(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(result.value.cta).toBe('none');
    expect(result.value.layout).toBe('a');
    expect(calls.map((call) => call.role)).toEqual(['write', 'judge']);
    // Скелет раскладки и границы длины уходят в запрос автора.
    expect(calls[0]?.input).toContain('от 400 до 700 видимых знаков');
    expect(calls[0]?.input).toContain('Совет редактора');
  });

  it('провал автора поднимается наверх', async () => {
    const { model } = fakeModel({ write: [new Error('модель молчит')] });
    expect(await producePost(brief(), deps(model))).toMatchObject({
      ok: false,
      reason: 'model_failed',
    });
  });
});

describe('правки', () => {
  it('реплика владельца идёт в круг правок, потом линт и редактор', async () => {
    const { model, calls } = fakeModel({ revise: [GOOD_DRAFT], judge: [judgePass()] });
    const result = await revisePost(
      { body: GOOD_DRAFT, context: reviewCtx() },
      { kind: 'instruction', text: 'убери второй абзац' },
      deps(model),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('pass');
    expect(calls.map((call) => call.role)).toEqual(['revise', 'judge']);
    expect(calls[0]?.input).toContain('убери второй абзац');
  });

  it('свой текст владельца идёт ДОСЛОВНО и без модели', async () => {
    const { model, calls } = fakeModel({});
    const mine = GOOD_DRAFT.replace('Оговорка:', 'Моя правка. Оговорка:');
    const result = await revisePost(
      { body: GOOD_DRAFT, context: reviewCtx() },
      { kind: 'owner_text', text: mine },
      deps(model),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe(mine);
    expect(calls).toEqual([]);
  });
});

describe('совет плану', () => {
  it('на пустой истории молчит: советовать нечего', () => {
    expect(advisePlan({ history: [] })).toBeUndefined();
  });

  it('называет рубрики в дефиците и что не повторять', () => {
    const history: HistoryPost[] = Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      cta: 'none',
      rubric: 'news',
      body: '# Google раздала память Gemini\n\nтело поста про память',
    }));
    const advice = advisePlan({ history });
    expect(advice?.text).toContain('В дефиците');
    // Рубрика «Как этим пользоваться» в плане есть, а в истории её нет.
    expect(advice?.rubricDeficit.join(' ')).toContain('Как этим пользоваться');
    expect(advice?.doNotRepeat.length).toBeGreaterThan(0);
  });
});

describe('сборка поста площадки', () => {
  it('крючок из ответа модели попадает в ТЕКСТ, а не остаётся в поле', () => {
    const body = threadsBody({
      hook: 'Память Gemini включили всем',
      pieces: ['Совсем другое начало первой части.'],
    });
    expect(body.split('\n')[0]).toBe('Память Gemini включили всем');
  });

  it('уже совпавший крючок не дублируется', () => {
    const body = threadsBody({
      hook: 'Память Gemini включили всем',
      pieces: ['Память Gemini включили всем. Дальше текст.'],
    });
    expect(body).toBe('Память Gemini включили всем. Дальше текст.');
  });

  it('одиночный пост со ссылкой НЕ получает её в первую часть', () => {
    const body = threadsBody({
      hook: 'Крючок',
      pieces: ['Крючок. Короткий пост одной частью.'],
      link: 'https://example.com/a',
    });
    const lint = lintThreads(body, { cta: 'none' });
    expect(lint.errors.map((error) => error.code)).not.toContain('threads_link_first');
    // Ссылка уходит ответом: так её видит и площадка, и читатель.
    expect(body.split(smmConfig.threads.separator)[0]).not.toContain('https://example.com/a');
    expect(body).toContain('https://example.com/a');
  });

  it('в цепочке ссылка остаётся в последней части', () => {
    const body = threadsBody({
      hook: 'Крючок',
      pieces: ['Первая часть.', 'Вторая часть.'],
      link: 'https://example.com/a',
    });
    const pieces = body.split(`\n${smmConfig.threads.separator}\n`);
    expect(pieces).toHaveLength(2);
    expect(pieces[1]).toContain('https://example.com/a');
  });
});

describe('текст владельца', () => {
  it('уходит дословно даже когда не проходит линт: модель его не трогает', async () => {
    const calls: ModelRole[] = [];
    const model: Model = {
      json(role) {
        calls.push(role);
        return Promise.resolve({ ok: false, reason: 'api_error', message: 'модель звать не должны' });
      },
      markdown(role) {
        calls.push(role);
        return Promise.resolve({ ok: false, reason: 'api_error', message: 'модель звать не должны' });
      },
    };
    const own = DRAFT_WITH_LINT_ERROR;
    const result = await revisePost(
      {
        body: GOOD_DRAFT,
        context: { platform: 'telegram', rubric: 'news', layout: 'a', cta: 'none', hasImage: false },
      },
      { kind: 'owner_text', text: own },
      { model, logger: createLogger({ level: 'fatal', stream: { write() {} } }) },
    );
    expect(result.ok && result.value.body).toBe(own);
    expect(calls).toEqual([]);
  });
});

describe('круг правок', () => {
  it('посту площадки даются границы ПЛОЩАДКИ, а не раскладки канала', () => {
    const own = reviseInput({
      body: 'текст',
      problems: 'коротко',
      layout: 'a',
      platform: 'threads',
    });
    expect(own).toContain(String(smmConfig.threads.pieceLimit));
    expect(own).toContain(smmConfig.threads.separator);
    expect(own).not.toContain('Раскладка А');
  });

  it('посту канала — границы его раскладки', () => {
    const channel = reviseInput({ body: 'текст', problems: 'коротко', layout: 'a' });
    expect(channel).toContain('Раскладка А');
    expect(channel).not.toContain(smmConfig.threads.separator);
  });
});
