import { z } from 'zod';

import { RUBRIC_KEYS, smmConfig, type JudgeCriterion } from '../config/smm.config.ts';

/**
 * Схемы ответов модели. Модель пишет и оценивает, но НЕ решает, что делать
 * дальше: каждый ответ обязан уложиться в схему, иначе шаг считается
 * провалившимся. Свободного ответа нет ни в одном шаге.
 */

const shortText = z.string().trim().min(1).max(400);
const longText = z.string().trim().min(1).max(2000);

/** Адрес: только http(s). Значение едет в разметку поста и в кнопку. */
const httpUrl = z
  .string()
  .trim()
  .max(600)
  .refine((raw) => /^https?:\/\//i.test(raw), 'адрес должен начинаться с http или https');

/** Факт с цитатой и адресом: утверждение без цитаты проверить нельзя. */
export const FactSchema = z.object({
  statement: shortText,
  quote: z.string().trim().min(1).max(400),
  url: httpUrl.optional(),
});

/**
 * Досье по первоисточнику. Дальше модель видит только его, а не сырую
 * страницу: так автор не может пересказать то, чего в источнике нет, а судья
 * сверяет факты по тому же тексту, что видел автор.
 *
 * `unknown` в полях про Россию и оплату — штатный ответ. Раньше агент на этом
 * месте додумывал («работает через VPN»), и это уходило в пост.
 */
/**
 * Сколько фактов просим. Потолок подобран под `max_tokens` роли `dossier`:
 * двенадцать фактов с цитатами не влезали в ответ, и шаг обрывался на лимите
 * токенов вместо того, чтобы разобраться (ревью тикета 03). Число уходит в
 * запрос вместе с досье — в промпте его нет намеренно.
 */
export const DOSSIER_FACTS_MAX = 8;
export const DOSSIER_NUMBERS_MAX = 12;
export const DOSSIER_DATES_MAX = 8;

/**
 * Список «не больше N»: лишнее ОТРЕЗАЕТСЯ, а не роняет шаг.
 *
 * ⚠️ Просьба в запросе потолок не держит: 23.09.2026 модель дважды подряд
 * вернула больше восьми фактов при «не больше 8» в тексте, и владелец получил
 * «Шаг не прошёл» вместо поста. Модель выписывает важное первым, поэтому хвост
 * терять дешевле, чем весь пост. Потолок по `max_tokens` это не отменяет:
 * оборванный ответ ловится отдельно (`stop_reason`), до схемы он не доходит.
 *
 * ⚠️ Режем ДО проверки элементов, а не после: иначе битый элемент в хвосте,
 * который всё равно отрежется (пустое утверждение у десятого факта), валил бы
 * досье целиком — тот же «Шаг не прошёл», только реже.
 */
function capped<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, max) : value),
    z.array(item).min(min).max(max),
  );
}

export const DossierSchema = z.object({
  title: shortText,
  facts: capped(FactSchema, DOSSIER_FACTS_MAX, 1),
  numbers: capped(
    z.object({ value: shortText, unit: z.string().trim().max(40).optional(), what: shortText }),
    DOSSIER_NUMBERS_MAX,
  ).default([]),
  dates: capped(z.object({ date: shortText, what: shortText }), DOSSIER_DATES_MAX).default([]),
  /** Что из этого новое для читателя с телефоном. */
  reader_new: longText,
  /**
   * `unknown` — штатный ответ, если из статьи это не следует. Отдельного типа
   * у него нет: значение всё равно сравнивается со строкой, а `union` с
   * литералом создавал бы видимость дискриминации, которой в типе нет.
   */
  works_in_russia: shortText,
  how_to_pay: shortText,
});

/** Литерал «из статьи не следует». Придумывать вместо него догадку нельзя. */
export const DOSSIER_UNKNOWN = 'unknown';

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
  const keys = criteria.map((c) => c.key);
  if (new Set(keys).size !== keys.length) {
    // Дубль ключа склеился бы в один при сборке схемы, и среднее считалось бы
    // по меньшему числу баллов — порог провала поехал бы молча.
    throw new Error(`критерии судьи содержат дубль: ${keys.join(', ')}`);
  }
  // `as` нужен, потому что ключи схемы известны только в рантайме: собрать
  // точный тип из массива нельзя, а вердикт всё равно считается по `scores`
  // как по словарю (`evaluateJudge`).
  const scores = z.object(
    Object.fromEntries(keys.map((key) => [key, z.number().int().min(1).max(5)])),
  ) as z.ZodType<Record<string, number>>;
  return z.object({
    scores,
    red_lines: z.enum(['pass', 'fail']),
    red_lines_reason: z.string().trim().max(400).default(''),
    // Критерий в претензии — только из списка: иначе судья ссылается на
    // выдуманный критерий, и правка уходит в пустоту.
    notes: z
      .array(JudgeNoteSchema.extend({ criterion: z.enum(keys as [string, ...string[]]) }))
      .max(12)
      .default([]),
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
  // Потолки читаются из конфига, а не дублируются здесь: лимиты площадки живут
  // в одном месте (инвариант «зеркала не заводим»). Запас по знакам на часть
  // двойной — точную длину с весом эмодзи считает линт.
  pieces: z
    .array(z.string().trim().min(1).max(smmConfig.threads.pieceLimit * 2))
    .min(1)
    .max(smmConfig.threads.maxPieces),
  tag: z.string().trim().max(smmConfig.threads.tagMax).optional(),
  link: httpUrl.optional(),
});

export type ThreadsPost = z.infer<typeof ThreadsPostSchema>;
