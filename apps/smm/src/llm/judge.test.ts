import { describe, expect, it } from 'vitest';

import { smmConfig } from '../config/smm.config.ts';
import { evaluateJudge, formatJudge } from './judge.ts';
import { judgeSchema } from './schemas.ts';

const CRITERIA = smmConfig.judge.telegram.criteria;

function answer(scores: Partial<Record<string, number>>, extra: Record<string, unknown> = {}) {
  const full = Object.fromEntries(CRITERIA.map((c) => [c.key, scores[c.key] ?? 5]));
  return judgeSchema(CRITERIA).parse({ scores: full, red_lines: 'pass', ...extra });
}

const BODY = '# Заголовок поста\n\nРаботает быстрее и удобнее, чем раньше.';

describe('вердикт судьи', () => {
  it('считает средний балл и минимум', () => {
    const verdict = evaluateJudge(answer({ texture: 3, voice: 4 }), BODY, smmConfig);
    expect(verdict.min).toBe(3);
    expect(verdict.mean).toBeCloseTo((5 * 5 + 3 + 4) / 7, 2);
    expect(verdict.verdict).toBe('pass');
  });

  it('красная линия — провал независимо от баллов', () => {
    const verdict = evaluateJudge(
      answer({}, { red_lines: 'fail', red_lines_reason: 'названа страна выпуска карты' }),
      BODY,
      smmConfig,
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.failReason).toBe('red_lines');
  });

  it('средний ниже порога — провал', () => {
    const verdict = evaluateJudge(
      answer({ so_what: 3, voice: 3, clarity: 3, headline: 3, structure: 3, facts: 4, texture: 4 }),
      BODY,
      smmConfig,
    );
    expect(verdict.mean).toBeLessThan(4);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.failReason).toBe('mean_below');
  });

  it('один критерий ниже трёх — провал даже при высоком среднем', () => {
    const verdict = evaluateJudge(answer({ texture: 2 }), BODY, smmConfig);
    expect(verdict.mean).toBeGreaterThan(4);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.failReason).toBe('criterion_below');
  });

  it('вердикт модели на решение не влияет: его считает код', () => {
    // В ответе может быть что угодно — verdict не читается оттуда вовсе.
    const raw = judgeSchema(CRITERIA).parse({
      scores: Object.fromEntries(CRITERIA.map((c) => [c.key, 1])),
      red_lines: 'pass',
      weakest: 'всё плохо',
    });
    const verdict = evaluateJudge({ ...raw, ...({ verdict: 'pass' } as object) }, BODY, smmConfig);
    expect(verdict.verdict).toBe('fail');
  });
});

describe('проверка цитат', () => {
  it('цитата, найденная в посте, помечается как найденная', () => {
    const verdict = evaluateJudge(
      answer({}, { notes: [{ criterion: 'texture', quote: 'быстрее и удобнее', note: 'оценка вместо картинки' }] }),
      BODY,
      smmConfig,
    );
    expect(verdict.notes[0]?.quoteFound).toBe(true);
    expect(verdict.unverifiedNotes).toBe(0);
  });

  it('выдуманная цитата помечается и считается', () => {
    // Судья той же модели, что автор, склонен придумывать претензии: код
    // проверяет, есть ли такая фраза в тексте вообще.
    const verdict = evaluateJudge(
      answer({}, { notes: [{ criterion: 'facts', quote: 'этого в посте нет', note: 'выдумка' }] }),
      BODY,
      smmConfig,
    );
    expect(verdict.notes[0]?.quoteFound).toBe(false);
    expect(verdict.unverifiedNotes).toBe(1);
  });

  it('кавычки, регистр и лишние пробелы не мешают найти цитату', () => {
    const verdict = evaluateJudge(
      answer({}, { notes: [{ criterion: 'voice', quote: '«Работает   БЫСТРЕЕ и удобнее»', note: 'оценка' }] }),
      BODY,
      smmConfig,
    );
    expect(verdict.notes[0]?.quoteFound).toBe(true);
  });

  it('претензия без цитаты считается непроверенной', () => {
    const verdict = evaluateJudge(
      answer({}, { notes: [{ criterion: 'voice', quote: '', note: 'звучит отчётом' }] }),
      BODY,
      smmConfig,
    );
    expect(verdict.unverifiedNotes).toBe(1);
  });
});

describe('отчёт судьи', () => {
  it('в одном формате для круга правок и для владельца', () => {
    const verdict = evaluateJudge(
      answer(
        { texture: 3 },
        {
          weakest: 'texture: пересказ без живой детали',
          notes: [{ criterion: 'texture', quote: 'быстрее и удобнее', note: 'оценка вместо картинки' }],
          fixes: ['Заменить оценку на сцену'],
        },
      ),
      BODY,
      smmConfig,
    );
    const report = formatJudge(verdict);
    expect(report).toContain('Редактор:');
    expect(report).toContain('texture=3');
    expect(report).toContain('Слабое место');
    expect(report).toContain('правка: Заменить оценку на сцену');
    expect(report).not.toContain('цитата в тексте не найдена');
  });

  it('непроверенная претензия помечается в отчёте', () => {
    const verdict = evaluateJudge(
      answer({}, { notes: [{ criterion: 'facts', quote: 'нет такого', note: 'выдумка' }] }),
      BODY,
      smmConfig,
    );
    expect(formatJudge(verdict)).toContain('цитата в тексте не найдена');
  });
});

describe('схема ответа судьи', () => {
  it('требует все критерии площадки', () => {
    const partial = { scores: { so_what: 5 }, red_lines: 'pass' };
    expect(judgeSchema(CRITERIA).safeParse(partial).success).toBe(false);
  });

  it('балл вне диапазона отвергается', () => {
    const bad = {
      scores: Object.fromEntries(CRITERIA.map((c) => [c.key, c.key === 'voice' ? 9 : 4])),
      red_lines: 'pass',
    };
    expect(judgeSchema(CRITERIA).safeParse(bad).success).toBe(false);
  });

  it('набор критериев Threads отличается от канала', () => {
    const threads = smmConfig.judge.threads.criteria;
    const full = Object.fromEntries(threads.map((c) => [c.key, 4]));
    expect(judgeSchema(threads).safeParse({ scores: full, red_lines: 'pass' }).success).toBe(true);
    // Критерии канала на схему Threads не подойдут: там есть hook и density.
    const channel = Object.fromEntries(CRITERIA.map((c) => [c.key, 4]));
    expect(judgeSchema(threads).safeParse({ scores: channel, red_lines: 'pass' }).success).toBe(false);
  });

  it('пустой список критериев — ошибка кода', () => {
    expect(() => judgeSchema([])).toThrowError(/критерии судьи не заданы/);
  });
});
