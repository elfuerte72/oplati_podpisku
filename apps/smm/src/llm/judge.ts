import type { SmmConfig } from '../config/smm.config.ts';
import type { JudgeAnswer, JudgeNote } from './schemas.ts';

/**
 * Вердикт редактора считает КОД, а не модель.
 *
 * Причина в спеке названа прямо: судья и автор — одна модель, и она хвалит свои
 * же обороты. Поэтому модель отдаёт только баллы и претензии, а порог провала,
 * среднее и проверку цитат считаем сами по конфигу. Модель, которая напишет
 * «verdict: pass», на решение не влияет никак.
 */

export interface CheckedNote extends JudgeNote {
  /** Нашлась ли цитата в тексте поста. Претензия без цитаты — не доказательство. */
  readonly quoteFound: boolean;
}

export interface JudgeVerdict {
  readonly mean: number;
  readonly min: number;
  readonly scores: Record<string, number>;
  readonly redLines: 'pass' | 'fail';
  readonly redLinesReason: string;
  readonly weakest: string;
  readonly fixes: readonly string[];
  readonly notes: readonly CheckedNote[];
  /** Сколько претензий пришло без цитаты или с выдуманной цитатой. */
  readonly unverifiedNotes: number;
  readonly verdict: 'pass' | 'fail';
  /** Почему провал — строкой для владельца и для круга правок. */
  readonly failReason?: 'red_lines' | 'mean_below' | 'criterion_below';
}

/** Сравнение текстов «как читает человек»: пробелы, кавычки и регистр не считаются. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateJudge(
  answer: JudgeAnswer,
  body: string,
  config: SmmConfig,
): JudgeVerdict {
  const scores = answer.scores;
  const values = Object.values(scores);
  if (values.length === 0) throw new Error('оценка судьи без баллов');
  const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  const min = Math.min(...values);

  const haystack = normalize(body);
  const notes: CheckedNote[] = answer.notes.map((note) => ({
    ...note,
    quoteFound: note.quote.trim() !== '' && haystack.includes(normalize(note.quote)),
  }));

  let failReason: JudgeVerdict['failReason'];
  if (answer.red_lines === 'fail') failReason = 'red_lines';
  else if (mean < config.judge.passMean) failReason = 'mean_below';
  else if (min < config.judge.minScore) failReason = 'criterion_below';

  return {
    mean,
    min,
    scores,
    redLines: answer.red_lines,
    redLinesReason: answer.red_lines_reason,
    weakest: answer.weakest,
    fixes: answer.fixes,
    notes,
    unverifiedNotes: notes.filter((note) => !note.quoteFound).length,
    verdict: failReason === undefined ? 'pass' : 'fail',
    failReason,
  };
}

/** Отчёт судьи для круга правок и для владельца. Один формат на оба случая. */
export function formatJudge(verdict: JudgeVerdict): string {
  const scores = Object.entries(verdict.scores)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const lines = [`Редактор: ${verdict.mean}/5 (${scores}), красные линии ${verdict.redLines}`];
  if (verdict.redLines === 'fail' && verdict.redLinesReason !== '') {
    lines.push(`Красная линия: ${verdict.redLinesReason}`);
  }
  if (verdict.weakest !== '') lines.push(`Слабое место: ${verdict.weakest}`);
  for (const note of verdict.notes) {
    // Претензия без найденной цитаты помечается: она может быть выдумана, и
    // автор не должен переписывать текст под несуществующую фразу.
    const mark = note.quoteFound ? '' : ' [цитата в тексте не найдена]';
    const quote = note.quote === '' ? '' : ` «${note.quote}»`;
    lines.push(`- ${note.criterion}:${quote} ${note.note}${mark}`);
  }
  for (const fix of verdict.fixes) lines.push(`- правка: ${fix}`);
  return lines.join('\n');
}
