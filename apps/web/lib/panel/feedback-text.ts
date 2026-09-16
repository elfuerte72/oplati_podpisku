import type { FunnelKind } from '@oplati/types';

import { lookupLabel } from './format';
import {
  EXPIRED_SURVEY_ANSWER_TITLES,
  FEEDBACK_TEXT,
  START_SURVEY_ANSWER_TITLES,
} from './labels';

/**
 * Ответ клиента на касание воронки словами: подпись кнопки для опросов,
 * «N из 5» для оценки. Один текст на два экрана — ленту «Обратной связи» и
 * карточку клиента, — иначе ответ `thinking` на одном читался бы «Ещё думает»,
 * а на другом сырым ключом.
 */
export function feedbackAnswerText(row: {
  kind: FunnelKind;
  score: number | null;
  answer: string | null;
}): string {
  if (row.kind === 'order_rating') {
    return row.score === null ? '—' : `${row.score} ${FEEDBACK_TEXT.scoreOf}`;
  }
  const dict =
    row.kind === 'expired_survey' ? EXPIRED_SURVEY_ANSWER_TITLES : START_SURVEY_ANSWER_TITLES;
  return lookupLabel(dict, row.answer ?? undefined) ?? row.answer ?? '—';
}

/** Низкая оценка — та, на которую персоналу уходит DM: 1–3. */
export function isLowRating(row: { kind: FunnelKind; score: number | null }): boolean {
  return row.kind === 'order_rating' && row.score !== null && row.score <= 3;
}
