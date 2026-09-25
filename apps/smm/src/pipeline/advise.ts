import { smmConfig, type CtaLevel, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { closingEmoji, headline, opener, shape, visibleText } from '../lint/text.ts';
import type { Advice, HistoryPost } from './types.ts';

/**
 * Советник: что автору НЕЛЬЗЯ и какой уровень рекламы у поста.
 *
 * Это код, а не модель: доли рубрик, потолок явной рекламы и список «не
 * повторять» — арифметика по истории, и модель тут добавила бы только
 * вариативность. Вывод советника уходит в промпт автора КАК ПРАВИЛО.
 */

/** Сколько последних постов смотрим на долю явной рекламы. */
const CTA_WINDOW = 10;

function rubricDeficit(
  published: readonly HistoryPost[],
  config: SmmConfig,
): string[] {
  if (published.length === 0) return [];
  const counts = new Map<string, number>();
  for (const post of published) {
    if (post.rubric === undefined) continue;
    counts.set(post.rubric, (counts.get(post.rubric) ?? 0) + 1);
  }
  const gaps: { gap: number; text: string }[] = [];
  for (const key of Object.keys(config.rubrics) as RubricKey[]) {
    const rubric = config.rubrics[key];
    const expected = rubric.share * published.length;
    const have = counts.get(key) ?? 0;
    if (expected - have >= 1) {
      gaps.push({
        gap: expected - have,
        text: `«${rubric.title}» ${have} из ${published.length} при плане ${Math.round(rubric.share * 100)}%`,
      });
    }
  }
  return gaps.sort((a, b) => b.gap - a.gap).map((row) => row.text);
}

/** Что занято последними постами: зачины, связки, концовки, форма. */
function freshnessNotes(previous: readonly HistoryPost[], config: SmmConfig): string[] {
  if (previous.length === 0) return [];
  const window = previous.slice(0, config.lint.freshnessWindow);
  const notes: string[] = [];

  const openers = window
    .map((post) => opener(headline(post.body)))
    .filter((value) => value !== '');
  if (openers.length > 0) {
    notes.push(`зачины заголовков: ${openers.map((value) => `«${value}»`).join(', ')}`);
  }

  const used = [
    ...new Set(
      window.flatMap((post) => {
        const low = visibleText(post.body).toLowerCase();
        return config.lint.stockPhrases.filter((phrase) => low.includes(phrase));
      }),
    ),
  ].sort();
  if (used.length > 0) {
    notes.push(`связки, которые уже были: ${used.map((value) => `«${value}»`).join(', ')}`);
  }

  const endings = window
    .slice(0, 2)
    .map((post) => closingEmoji(visibleText(post.body)))
    .filter((value) => value !== '');
  if (endings.length > 0) notes.push(`концовки: ${endings.join(' ')}`);

  const shapes = window.slice(0, 3).map((post) => shape(post.body));
  if (
    shapes.length === 3 &&
    shapes.every((form) => form.hasH2 && form.hasList)
  ) {
    notes.push('три последних поста: подзаголовок плюс список, этому лучше дать другую форму');
  }
  return notes;
}

export interface AdviseInput {
  readonly rubric: RubricKey;
  /** Последние вышедшие посты площадки, свежие первыми. */
  readonly history?: readonly HistoryPost[];
  /**
   * Речь о платной подписке на ИИ-сервис: одно упоминание «оплатим рублями»
   * тогда уместно даже там, где рубрика по умолчанию молчит.
   */
  readonly aboutPaidService?: boolean;
  /**
   * Пост без рекламы ВНЕ зависимости от рубрики: черновик по расписанию
   * уходит и в канал без рекламы (Aibromotion), и один текст обязан годиться
   * для обоих. Перекрывает всё остальное, включая `aboutPaidService`.
   */
  readonly noAds?: boolean;
  readonly config?: SmmConfig;
}

export function advise(input: AdviseInput): Advice {
  const config = input.config ?? smmConfig;
  const history = input.history ?? [];
  const rubric = config.rubrics[input.rubric];
  const window = history.slice(0, CTA_WINDOW);

  const hardCount = window.filter((post) => post.cta === 'hard').length;
  const hardShare = window.length === 0 ? 0 : hardCount / window.length;
  const lastTwoHard = window.length >= 2 && window.slice(0, 2).every((post) => post.cta === 'hard');
  // Доля считается только на выборке от пяти постов: на одном-двух любой
  // процент врёт.
  const enoughHistory = window.length >= config.ads.minHistoryForShare;

  let cta: CtaLevel = rubric.cta;
  const reasons = [`рубрика «${rubric.title}» по умолчанию: ${cta}`];

  if (
    cta === 'hard' &&
    ((enoughHistory && hardShare >= config.ads.hardMaxShare) ||
      (config.ads.noTwoHardInARow && lastTwoHard))
  ) {
    cta = 'soft';
    reasons.push(
      enoughHistory && hardShare >= config.ads.hardMaxShare
        ? `явной рекламы уже много (${Math.round(hardShare * 100)}% последних постов, потолок ${Math.round(config.ads.hardMaxShare * 100)}%), снижаю до soft`
        : 'два последних поста уже с явным призывом, снижаю до soft',
    );
  }

  if (input.aboutPaidService === true && cta === 'none') {
    cta = 'soft';
    reasons.push('речь о платной подписке на ИИ-сервис: одно упоминание уместно');
  }

  if (input.noAds === true && cta !== 'none') {
    cta = 'none';
    reasons.push('черновик по расписанию: без рекламы, чтобы текст годился и для канала без рекламы');
  }

  const deficit = rubricDeficit(window, config);
  const doNotRepeat = freshnessNotes(history, config);

  const lines = [`Уровень рекламы: ${cta}.`, ...reasons.map((reason) => `- ${reason}`)];
  lines.push(
    cta === 'none'
      ? '- Как писать: ни слова про бота и про Оплатишку, пост ценен сам по себе.'
      : cta === 'soft'
        ? '- Как писать: одно упоминание внутри текста по делу, без отдельной строки-призыва.'
        : '- Как писать: одна строка призыва в конце, привязанная к содержанию поста.',
  );
  if (deficit.length > 0) {
    lines.push(`Дефицит рубрик: ${deficit.join('; ')}.`);
    if (!deficit.some((row) => row.includes(rubric.title))) {
      lines.push('- Если материал позволяет, поверни его в рубрику из дефицита.');
    }
  }
  for (const note of doNotRepeat) lines.push(`Не повторять: ${note}.`);

  return { cta, ctaReasons: reasons, rubricDeficit: deficit, doNotRepeat, text: lines.join('\n') };
}

/**
 * Совет ПЛАНУ: какие рубрики в дефиците и что не повторять.
 *
 * Отдельно от `advise`, потому что тому нужна рубрика — а план как раз её и
 * предлагает. Считается теми же функциями: второй формулы дефицита нет.
 */
export interface PlanAdvice {
  readonly rubricDeficit: readonly string[];
  readonly doNotRepeat: readonly string[];
  readonly text: string;
}

export function advisePlan(input: {
  history?: readonly HistoryPost[];
  config?: SmmConfig;
}): PlanAdvice | undefined {
  const config = input.config ?? smmConfig;
  const history = input.history ?? [];
  if (history.length === 0) return undefined;
  const deficit = rubricDeficit(history.slice(0, CTA_WINDOW), config);
  const doNotRepeat = freshnessNotes(history, config);
  if (deficit.length === 0 && doNotRepeat.length === 0) return undefined;

  const lines: string[] = [];
  if (deficit.length > 0) lines.push(`В дефиците: ${deficit.join('; ')}.`);
  for (const note of doNotRepeat) lines.push(`Не повторять: ${note}.`);
  return { rubricDeficit: deficit, doNotRepeat, text: lines.join('\n') };
}
