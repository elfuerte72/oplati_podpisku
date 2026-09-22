import {
  smmConfig,
  type CtaLevel,
  type JudgeCriterion,
  type LayoutKey,
  type RubricKey,
  type SmmConfig,
} from '../config/smm.config.ts';
import { DOSSIER_FACTS_MAX, type Dossier } from '../llm/schemas.ts';
import type { Advice } from './types.ts';

/**
 * Входы для модели: всё, что зависит от конфига и данных, собирается ЗДЕСЬ, а
 * не в промпте. Промпт объясняет роль, запрос приносит числа — поэтому смена
 * границы длины или потолка фактов не требует правки промпта и не может с ним
 * разойтись.
 */

/** Обрезка статьи с сохранением начала и конца: середина длинных страниц — реклама. */
export function trimArticle(text: string, limit = 12_000): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, Math.floor(limit * 0.7));
  const tail = clean.slice(-Math.floor(limit * 0.3));
  return `${head}\n\n[...середина статьи опущена...]\n\n${tail}`;
}

export function dossierInput(article: { title: string; text: string; url: string }): string {
  return [
    `Адрес статьи: ${article.url}`,
    `Заголовок: ${article.title}`,
    '',
    `Фактов выпиши не больше ${DOSSIER_FACTS_MAX}, самые важные для читателя.`,
    '',
    'Текст статьи:',
    '<<<',
    trimArticle(article.text),
    '>>>',
  ].join('\n');
}

function rubricList(config: SmmConfig): string {
  return (Object.keys(config.rubrics) as RubricKey[])
    .map((key) => {
      const rubric = config.rubrics[key];
      return `- ${key} («${rubric.title}»): ${rubric.inside}`;
    })
    .join('\n');
}

export function planInput(input: {
  dossier: Dossier;
  advice?: { readonly text: string };
  config?: SmmConfig;
  /** Углы, которые владелец уже видел: «Другие углы» не должны их повторить. */
  seenAngles?: readonly string[];
}): string {
  const config = input.config ?? smmConfig;
  const parts = [
    'Досье:',
    JSON.stringify(input.dossier, null, 2),
    '',
    'Рубрики канала:',
    rubricList(config),
  ];
  if (input.advice !== undefined) {
    parts.push('', 'Совет редактора (это правило, а не подсказка):', input.advice.text);
  }
  if (input.seenAngles !== undefined && input.seenAngles.length > 0) {
    parts.push(
      '',
      'Эти углы владелец уже видел и не выбрал, предложи другие:',
      ...input.seenAngles.map((angle) => `- ${angle}`),
    );
  }
  return parts.join('\n');
}

export function writeInput(input: {
  dossier: Dossier;
  rubric: RubricKey;
  layout: LayoutKey;
  angle: string;
  advice: Advice;
  config?: SmmConfig;
}): string {
  const config = input.config ?? smmConfig;
  const layout = config.layouts[input.layout];
  const rubric = config.rubrics[input.rubric];
  return [
    `Рубрика: «${rubric.title}» — ${rubric.inside}.`,
    `Угол: ${input.angle}`,
    '',
    `Раскладка ${layout.letter} («${layout.title}»), от ${layout.minChars} до ${layout.maxChars} видимых знаков.`,
    'Скелет:',
    ...layout.skeleton.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Совет редактора (это правило):',
    input.advice.text,
    '',
    'Досье:',
    JSON.stringify(input.dossier, null, 2),
  ].join('\n');
}

export function reviseInput(input: {
  body: string;
  problems: string;
  layout: LayoutKey;
  /** Площадка: у Threads другие границы и своя форма цепочки. */
  platform?: 'telegram' | 'threads';
  dossier?: Dossier;
  config?: SmmConfig;
}): string {
  const config = input.config ?? smmConfig;
  const layout = config.layouts[input.layout];
  const limits = config.threads;
  // ⚠️ Границы берутся ПО ПЛОЩАДКЕ. Пост Threads раскладки не имеет, и
  // правка по правилам канала («от 400 до 700 знаков», «структуру раскладки
  // не меняешь») схлопывала цепочку и выводила части за лимит площадки.
  const frame =
    input.platform === 'threads'
      ? [
          `Пост для Threads: части разделены строкой «${limits.separator}», каждая до ${limits.pieceLimit} знаков ` +
            `(первая лучше всего читается до ${limits.postTarget}, ответы — до ${limits.replyTarget}).`,
          'Разметки нет: ни заголовков, ни звёздочек, ни списков. Число частей и ссылку в последней не меняй.',
        ]
      : [`Раскладка ${layout.letter}, от ${layout.minChars} до ${layout.maxChars} видимых знаков.`];
  const parts = [
    ...frame,
    '',
    'Замечания, которые надо исправить (и только их):',
    input.problems,
    '',
    'Текст поста:',
    '<<<',
    input.body,
    '>>>',
  ];
  if (input.dossier !== undefined) {
    parts.push('', 'Досье (новых утверждений вне него быть не должно):', JSON.stringify(input.dossier));
  }
  return parts.join('\n');
}

function criteriaBlock(criteria: readonly JudgeCriterion[]): string {
  return criteria.map((criterion) => `- ${criterion.key}: ${criterion.description}`).join('\n');
}

export function judgeInput(input: {
  body: string;
  rubric: RubricKey;
  cta: CtaLevel;
  platform: 'telegram' | 'threads';
  angle?: string;
  dossier?: Dossier;
  config?: SmmConfig;
}): string {
  const config = input.config ?? smmConfig;
  const rules = input.platform === 'threads' ? config.judge.threads : config.judge.telegram;
  const parts = [
    `Рубрика: «${config.rubrics[input.rubric].title}»`,
    `Уровень рекламы (cta): ${input.cta}`,
  ];
  if (input.angle !== undefined) parts.push(`Угол, который выбрал владелец: ${input.angle}`);
  parts.push(
    '',
    'Критерии (оценивай только по ним):',
    criteriaBlock(rules.criteria),
    '',
    `Красные линии (любое нарушение — red_lines: fail): ${rules.redLines}`,
  );
  if (input.dossier !== undefined) {
    parts.push('', 'Досье источника (для сверки фактов):', JSON.stringify(input.dossier));
  }
  parts.push(
    '',
    input.platform === 'threads'
      ? 'Пост для Threads (первая часть — сам пост, дальше ответы-продолжения):'
      : 'Пост (обложку и подпись «Источник» добавит код):',
    '<<<',
    input.body,
    '>>>',
  );
  return parts.join('\n');
}

export function threadsInput(input: {
  dossier: Dossier;
  angle: string;
  link?: string;
  config?: SmmConfig;
}): string {
  const config = input.config ?? smmConfig;
  const limits = config.threads;
  return [
    `Угол: ${input.angle}`,
    '',
    `Ограничения площадки: до ${limits.maxPieces} частей, каждая до ${limits.pieceLimit} знаков ` +
      `(эмодзи считается за ${limits.emojiWeight}), крючок до ${limits.hookMax} знаков, ` +
      `эмодзи на часть до ${limits.emojiMax}.`,
    input.link === undefined
      ? 'Ссылки нет: поле link оставь пустым.'
      : `Ссылка на первоисточник (в поле link, не в тексте): ${input.link}`,
    '',
    'Досье:',
    JSON.stringify(input.dossier, null, 2),
  ].join('\n');
}

/**
 * Вход роли `rank`. Числа и списки собираются ЗДЕСЬ, а не в промпте: рубрики
 * канала, наши посты за окно и темы «не по теме» — данные, и меняются они
 * настройкой, а не правкой формулировок.
 */
export function rankInput(input: {
  items: readonly { url: string; title?: string; sourceKind: string; sourceRef?: string; publishedAt?: string }[];
  published?: readonly { title: string; url?: string }[];
  offtopic?: readonly string[];
  config?: SmmConfig;
}): string {
  const config = input.config ?? smmConfig;
  const parts = ['Рубрики канала:', rubricList(config), ''];

  parts.push('Темы на оценку:');
  for (const item of input.items) {
    const where = item.sourceRef === undefined ? item.sourceKind : `${item.sourceKind}/${item.sourceRef}`;
    const when = item.publishedAt === undefined ? '' : ` · ${item.publishedAt.slice(0, 10)}`;
    parts.push(`- ${item.url} · ${item.title ?? 'без заголовка'} · ${where}${when}`);
  }

  const published = input.published ?? [];
  if (published.length > 0) {
    parts.push('', 'Наши посты за последние два месяца:');
    for (const post of published) {
      parts.push(`- ${post.title}${post.url === undefined ? '' : ` · ${post.url}`}`);
    }
  }

  const offtopic = input.offtopic ?? [];
  if (offtopic.length > 0) {
    parts.push('', 'Владелец отметил как «не по теме» (похожее — relevance 1):');
    for (const title of offtopic) parts.push(`- ${title}`);
  }

  return parts.join('\n');
}
