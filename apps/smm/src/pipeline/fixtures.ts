import { smmConfig, type JudgeCriterion } from '../config/smm.config.ts';
import type { Dossier } from '../llm/schemas.ts';
import type { HistoryPost } from './types.ts';

/** Фикстуры ответов модели по ролям: конвейер тестируется без сети и без денег. */

export const DOSSIER: Dossier = {
  title: 'Google открыла память Gemini бесплатным пользователям',
  facts: [
    {
      statement: 'Память включена всем бесплатным аккаунтам',
      quote: 'memory is now available to all users, including the free tier',
      url: 'https://blog.example.com/gemini-memory',
    },
    {
      statement: 'Помощник помнит прошлые разговоры без напоминаний',
      quote: 'Gemini can recall details from past conversations automatically',
    },
  ],
  numbers: [{ value: '2', unit: 'недели', what: 'сколько заняло раскатывание' }],
  dates: [{ date: '2026-09-18', what: 'объявление в блоге' }],
  reader_new: 'Не нужно пересказывать вчерашний разговор заново',
  works_in_russia: 'unknown',
  how_to_pay: 'unknown',
};

/** Пост раскладки А, который проходит линт: на нём проверяется счастливый путь. */
export const GOOD_DRAFT = `# Google раздала память Gemini бесплатным пользователям

Раньше приходилось каждый раз пересказывать, о чём шла речь вчера. Теперь
помощник помнит прошлые разговоры сам (и это заметно в первом же вопросе).

Проверить можно за минуту: открой приложение и спроси о том, что обсуждал
неделю назад. Если помнит, значит функция уже дошла до твоего аккаунта.

Оговорка: в блоге не сказано, работает ли это в России.`;

/** Тот же пост, но с длинным тире: линт обязан его отвергнуть. */
export const DRAFT_WITH_LINT_ERROR = GOOD_DRAFT.replace(
  'Оговорка:',
  'Это важно — и вот почему. Оговорка:',
);

/** Ответ судьи: `pass` по всем критериям площадки. */
export function judgePass(criteria: readonly JudgeCriterion[] = smmConfig.judge.telegram.criteria) {
  return {
    scores: Object.fromEntries(criteria.map((c) => [c.key, 5])),
    red_lines: 'pass',
    notes: [],
    weakest: '',
    fixes: [],
  };
}

/** Ответ судьи с провалом по живой детали: самое частое слабое место. */
export function judgeFail(criteria: readonly JudgeCriterion[] = smmConfig.judge.telegram.criteria) {
  return {
    scores: Object.fromEntries(criteria.map((c) => [c.key, c.key === 'texture' ? 2 : 5])),
    red_lines: 'pass',
    notes: [
      {
        criterion: 'texture',
        quote: 'Проверить можно за минуту',
        note: 'пересказ без живой детали',
      },
    ],
    weakest: 'texture: пересказ источника без живой детали',
    fixes: ['Добавить сцену: что именно читатель увидит в приложении'],
  };
}

export const PLAN_ANSWER = {
  rubric: 'news',
  angles: [
    { title: 'Память Gemini включена всем', idea: 'Что изменилось и где это видно', reader_action: false },
    { title: 'Проверь память в своём аккаунте', idea: 'Где нажать и как убедиться', reader_action: true },
    { title: 'Чем это отличается от истории чатов', idea: 'Разница на бытовом примере', reader_action: false },
  ],
  nothing_changes: false,
};

export const PLAN_NOTHING_CHANGES = {
  ...PLAN_ANSWER,
  nothing_changes: true,
  note: 'функция уже была у всех, кроме нескольких стран',
};

/** История канала: рубрики, уровни рекламы и тексты для свежести. */
export const HISTORY: HistoryPost[] = [
  { id: 'p1', rubric: 'news', cta: 'none', body: '# Первый пост про новости ИИ\n\nЕсли коротко, вышла новая модель.' },
  { id: 'p2', rubric: 'news', cta: 'none', body: '# Второй пост про новости ИИ\n\nТак вот, снова обновление.' },
  { id: 'p3', rubric: 'news', cta: 'hard', body: '# Третий пост про новости ИИ\n\nОплатить подписку можно у нас: @oplatishkaa_bot' },
  { id: 'p4', rubric: 'plain', cta: 'none', body: '# Простыми словами про токены\n\nЭто как слоги в словах.' },
];

/** Пост для Threads, проходящий линт площадки: без разметки, ссылка в конце. */
export const THREADS_POST = {
  hook: 'Память Gemini включили всем, кто не платит',
  pieces: [
    'Память Gemini включили всем, кто не платит.\n\nРаньше помощник забывал вчерашний разговор, теперь помнит сам.',
    'Проверяется за минуту: спроси о том, что обсуждал неделю назад. Помнит? Значит, доехало и до тебя.\n\nПро Россию в блоге не сказано ничего (и это стоит держать в голове).',
  ],
  tag: 'gemini',
  link: 'https://blog.example.com/gemini-memory',
} as const;

/** Одиночный пост площадки: дефолтный случай тикета, а не цепочка. */
export const THREADS_SINGLE_POST = {
  hook: 'Память Gemini включили всем, кто не платит',
  pieces: [
    'Память Gemini включили всем, кто не платит.\n\nРаньше помощник забывал вчерашний разговор, теперь помнит сам. Проверяется за минуту: спроси о том, что обсуждал неделю назад.',
  ],
  tag: 'gemini',
  link: 'https://blog.example.com/gemini-memory',
} as const;
