import { describe, expect, it } from 'vitest';

import { feedbackAnswerText, isLowRating } from './feedback-text';
import {
  EXPIRED_SURVEY_ANSWER_TITLES,
  FEEDBACK_TEXT,
  START_SURVEY_ANSWER_TITLES,
} from './labels';

/**
 * Ответ на касание воронки словами — один текст на ленту «Обратной связи» и
 * карточку клиента.
 */
describe('feedbackAnswerText', () => {
  it('оценка — «N из 5», без оценки — прочерк', () => {
    expect(feedbackAnswerText({ kind: 'order_rating', score: 4, answer: null })).toBe(
      `4 ${FEEDBACK_TEXT.scoreOf}`,
    );
    expect(feedbackAnswerText({ kind: 'order_rating', score: null, answer: null })).toBe('—');
  });

  it('ответ опроса подписывается словарём своего вида', () => {
    expect(feedbackAnswerText({ kind: 'expired_survey', score: null, answer: 'price' })).toBe(
      EXPIRED_SURVEY_ANSWER_TITLES.price,
    );
    expect(feedbackAnswerText({ kind: 'start_survey', score: null, answer: 'thinking' })).toBe(
      START_SURVEY_ANSWER_TITLES.thinking,
    );
  });

  it('неизвестный ответ показывается как есть, пустой — прочерком', () => {
    // Кнопка может появиться в боте раньше строки словаря — прочерк скрыл бы
    // сам факт ответа.
    expect(feedbackAnswerText({ kind: 'start_survey', score: null, answer: 'brand_new' })).toBe(
      'brand_new',
    );
    expect(feedbackAnswerText({ kind: 'referral_nudge', score: null, answer: null })).toBe('—');
  });
});

describe('isLowRating', () => {
  it('низкая оценка — 1–3, на неё персоналу уходит DM; 4 и опросы — нет', () => {
    expect(isLowRating({ kind: 'order_rating', score: 3 })).toBe(true);
    expect(isLowRating({ kind: 'order_rating', score: 4 })).toBe(false);
    expect(isLowRating({ kind: 'order_rating', score: null })).toBe(false);
    expect(isLowRating({ kind: 'expired_survey', score: 1 })).toBe(false);
  });
});
