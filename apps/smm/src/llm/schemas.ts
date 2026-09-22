import { z } from 'zod';

import { RUBRIC_KEYS, type JudgeCriterion } from '../config/smm.config.ts';

/**
 * Схемы ответов модели. Модель пишет и оценивает, но НЕ решает, что делать
 * дальше: каждый ответ обязан уложиться в схему, иначе шаг считается
 * провалившимся. Свободного ответа нет ни в одном шаге.
 */

const shortText = z.string().trim().min(1).max(400);
const longText = z.string().trim().min(1).max(2000);

/** Факт с цитатой и адресом: утверждение без цитаты проверить нельзя. */
export const FactSchema = z.object({
  statement: shortText,
  quote: z.string().trim().min(1).max(600),
  url: z.string().trim().max(500).optional(),
});

/**
 * Досье по первоисточнику. Дальше модель видит только его, а не сырую
 * страницу: так автор не может пересказать то, чего в источнике нет, а судья
 * сверяет факты по тому же тексту, что видел автор.
 *
 * `unknown` в полях про Россию и оплату — штатный ответ. Раньше агент на этом
 * месте додумывал («работает через VPN»), и это уходило в пост.
 */
export const DossierSchema = z.object({
  title: shortText,
  facts: z.array(FactSchema).min(1).max(12),
  numbers: z
    .array(z.object({ value: shortText, unit: z.string().trim().max(40).optional(), what: shortText }))
    .max(12)
    .default([]),
  dates: z.array(z.object({ date: shortText, what: shortText })).max(8).default([]),
  /** Что из этого новое для читателя с телефоном. */
  reader_new: longText,
  works_in_russia: z.union([z.literal('unknown'), shortText]),
  how_to_pay: z.union([z.literal('unknown'), shortText]),
});

export type Dossier = z.infer<typeof DossierSchema>;

export const AngleSchema = z.object({
  title: z.string().trim().min(3).max(140),
  idea: longText,
  /** Угол про действие читателя: «что сделать сегодня», а не «что произошло». */
  reader_action: z.boolean(),
});

export type Angle = z.infer<typeof AngleSchema>;

/**
 * План поста: рубрика и три угла.
 *
 * Требование «хотя бы один угол про действие читателя» форсится схемой. В
 * промпте просим ровно один, но ронять годный план из-за того, что модель
 * пометила два, — формальность: важно, что угол про действие есть вообще.
 */
export const PlanSchema = z.object({
  rubric: z.enum(RUBRIC_KEYS),
  angles: z
    .array(AngleSchema)
    .length(3)
    .refine((angles) => angles.some((angle) => angle.reader_action), {
      message: 'ни один угол не про действие читателя',
    }),
  /**
   * «Для читателя ничего не меняется» — отдельный флаг, а не вывод в тексте:
   * по нему бот предлагает другую тему ДО того, как пост написан.
   */
  nothing_changes: z.boolean(),
  note: z.string().trim().max(400).optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

/** Претензия судьи: критерий, ЦИТАТА из поста и что с ней не так. */
export const JudgeNoteSchema = z.object({
  criterion: z.string().trim().min(1).max(40),
  quote: z.string().trim().max(400).default(''),
  note: shortText,
});

export type JudgeNote = z.infer<typeof JudgeNoteSchema>;

/**
 * Оценка редактора. Итоговый вердикт считает КОД по порогам конфига
 * (`evaluateJudge`), а не модель: иначе «pass» зависел бы от её настроения, а
 * пороги жили бы в промпте.
 */
export function judgeSchema(criteria: readonly JudgeCriterion[]) {
  if (criteria.length === 0) throw new Error('критерии судьи не заданы');
  const scores = z.object(
    Object.fromEntries(criteria.map((c) => [c.key, z.number().int().min(1).max(5)])),
  ) as z.ZodType<Record<string, number>>;
  return z.object({
    scores,
    red_lines: z.enum(['pass', 'fail']),
    red_lines_reason: z.string().trim().max(400).default(''),
    notes: z.array(JudgeNoteSchema).max(12).default([]),
    weakest: z.string().trim().max(400).default(''),
    fixes: z.array(shortText).max(5).default([]),
  });
}

export type JudgeAnswer = z.infer<ReturnType<typeof judgeSchema>>;

/** Оценка идеи из источников: пачками по 20, поэтому ответ — массив. */
export const RankItemSchema = z.object({
  url: z.string().trim().min(1).max(600),
  rubric: z.enum(RUBRIC_KEYS).optional(),
  relevance: z.number().int().min(1).max(5),
  reader_action: z.boolean(),
  already_covered: z.boolean(),
  why: z.string().trim().max(300).optional(),
});

export const RankSchema = z.array(RankItemSchema).max(40);

export type RankItem = z.infer<typeof RankItemSchema>;

/**
 * Пост для Threads. Крючок отдельным полем: в ленте видна только первая
 * строка, и она обязана работать сама по себе.
 */
export const ThreadsPostSchema = z.object({
  hook: z.string().trim().min(1).max(300),
  pieces: z.array(z.string().trim().min(1).max(1000)).min(1).max(5),
  tag: z.string().trim().max(50).optional(),
  link: z.string().trim().max(600).optional(),
});

export type ThreadsPost = z.infer<typeof ThreadsPostSchema>;
