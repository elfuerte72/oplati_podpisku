import { smmConfig, type Layout, type SmmConfig } from '../config/smm.config.ts';
import {
  AI_PHRASES,
  BOT_RE,
  BRAND_RE,
  BRAND_SCOPED_RED_LINES,
  CARD_COUNTRY_WINDOW,
  CARD_RE,
  COUNTRY_RE,
  EMPTY_OPENERS,
  JARGON_RE,
  PAN_RE,
  RED_LINES,
  SO_WHAT_RE,
  SPECIAL_BLOCK_PATTERNS,
  hasVerbHint,
  VOICE_RE,
  WARNING_PATTERNS,
} from './rules.ts';
import {
  bullets,
  closingEmoji,
  codeBlocks,
  countEmoji,
  countNumbers,
  headings,
  headline,
  IMAGE_MARKER,
  opener,
  orderedSteps,
  paragraphs,
  sentences,
  shape,
  tables,
  visibleText,
} from './text.ts';
import type { Finding, LintContext, LintResult, PreviousPost } from './types.ts';

/**
 * Линт поста канала: первый и главный гейт качества. Он работает ДО редактора
 * и держит то, что модель забывает из раза в раз — форму раскладки, воздух,
 * числа, свежесть и красные линии.
 *
 * Правила не «придирки»: каждое стоит на конкретном провале прошлого контура,
 * и причина написана рядом с ним в `rules.ts`.
 */

class Collector {
  readonly errors: Finding[] = [];
  readonly warnings: Finding[] = [];

  error(code: string, message: string): void {
    this.errors.push({ code, message });
  }

  warn(code: string, message: string): void {
    this.warnings.push({ code, message });
  }

  result(): LintResult {
    return { errors: this.errors, warnings: this.warnings };
  }
}

function checkHeadline(raw: string, out: Collector): void {
  const { h1 } = headings(raw);
  if (h1.length === 0) {
    out.error('no_h1', 'нет заголовка: первая строка поста это «# Заголовок»');
    return;
  }
  if (h1.length > 1) {
    out.error('multiple_h1', `заголовков первого уровня ${h1.length}, нужен один`);
  }
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine !== undefined && !firstLine.startsWith('# ')) {
    out.error('h1_not_first', 'заголовок не первой строкой: перед ним не должно быть текста');
  }
  const title = h1[0] ?? '';
  for (const pattern of EMPTY_OPENERS) {
    if (pattern.test(title)) {
      out.error('empty_opener', `пустой зачин заголовка «${title.slice(0, 40)}»: начни с факта`);
      break;
    }
  }
  if (!hasVerbHint(title)) {
    // Предупреждение, а не ошибка: морфологии у нас нет, и эвристика не должна
    // ронять пост. Заголовок-тему заметит и редактор.
    out.warn(
      'headline_no_verb',
      'заголовок похож на тему, а не на утверждение: в нём не видно сказуемого',
    );
  }
}

function checkLayout(raw: string, layout: Layout, out: Collector): void {
  const { h2 } = headings(raw);
  const bulletList = bullets(raw);
  const steps = orderedSteps(raw);
  const code = codeBlocks(raw);
  const tableList = tables(raw);
  const rules = layout.structure;
  const where = `раскладка ${layout.letter} («${layout.title}»)`;

  if (rules.h2 === 'forbidden' && h2.length > 0) {
    out.error('layout_h2_forbidden', `${where}: подзаголовков быть не должно`);
  }
  if (rules.h2 === 'required-one' && h2.length !== 1) {
    out.error('layout_h2_required', `${where}: нужен ровно один подзаголовок «##», найдено ${h2.length}`);
  }

  if (rules.bullets === 'forbidden' && bulletList.length > 0) {
    out.error('layout_bullets_forbidden', `${where}: списка быть не должно`);
  }
  if (typeof rules.bullets === 'object') {
    if (bulletList.length < rules.bullets.min || bulletList.length > rules.bullets.max) {
      out.error(
        'layout_bullets_count',
        `${where}: пунктов списка ${bulletList.length}, нужно от ${rules.bullets.min} до ${rules.bullets.max}`,
      );
    } else {
      const withBold = bulletList.filter((item) => item.startsWith('**')).length;
      if (withBold < bulletList.length) {
        out.warn(
          'layout_bullets_bold',
          `${where}: пункты начинаются жирным — «- **Начало.** пояснение»`,
        );
      }
    }
  }

  if (rules.orderedSteps === 'required' && steps.length < 2) {
    out.error('layout_steps_required', `${where}: шаги идут нумерованным списком`);
  }
  if (rules.orderedSteps === 'forbidden' && steps.length > 0) {
    out.error('layout_steps_forbidden', `${where}: нумерованного списка быть не должно`);
  }

  if (rules.codeBlock === 'required-one' && code.length !== 1) {
    out.error(
      'layout_code_required',
      `${where}: нужен ровно один блок с готовой фразой, найдено ${code.length}`,
    );
  }
  if (rules.codeBlock === 'forbidden' && code.length > 0) {
    out.error('layout_code_forbidden', `${where}: блока с кодом быть не должно`);
  }

  if (rules.table === 'required-one' && tableList.length !== 1) {
    out.error('layout_table_required', `${where}: нужна ровно одна таблица, найдено ${tableList.length}`);
  }
  if (rules.table === 'forbidden' && tableList.length > 0) {
    out.error('layout_table_forbidden', `${where}: таблицы быть не должно`);
  }
}

function checkLength(visible: string, layout: Layout, config: SmmConfig, out: Collector): void {
  const length = visible.length;
  if (length > config.lint.visibleTextMax) {
    out.error(
      'visible_too_long',
      `длина ${length} видимых знаков, потолок ${config.lint.visibleTextMax}`,
    );
    return;
  }
  if (length < layout.minChars) {
    out.error(
      'length_short',
      `видимого текста ${length} знаков, раскладка ${layout.letter} просит от ${layout.minChars}`,
    );
  }
  if (length > layout.maxChars) {
    out.error(
      'length_long',
      `видимого текста ${length} знаков, раскладка ${layout.letter} держит до ${layout.maxChars}`,
    );
  }
}

/**
 * Стена текста. Telegram рисует соседние абзацы ВПЛОТНУЮ: три длинных абзаца
 * подряд читатель видит одним кирпичом, даже если текст хороший (живой пост
 * 11.09.2026, жалоба владельца). Воздух даёт только структурный блок.
 */
function checkWall(raw: string, config: SmmConfig, out: Collector): void {
  let runCount = 0;
  let runChars = 0;
  let flagged = false;

  const closeRun = (): void => {
    if (!flagged && runCount >= config.lint.wallMinParagraphs && runChars > config.lint.wallMaxChars) {
      out.error(
        'wall',
        `стена текста: ${runCount} абзаца подряд на ${runChars} знаков без подзаголовка, ` +
          'списка или цитаты. Раздели их структурой или сократи',
      );
      flagged = true;
    }
    runCount = 0;
    runChars = 0;
  };

  for (const block of paragraphs(raw)) {
    if (block.isBlock) {
      closeRun();
      continue;
    }
    const size = block.visible.length;
    if (size > config.lint.paragraphMaxChars) {
      out.error(
        'paragraph_long',
        `абзац на ${size} знаков: потолок ${config.lint.paragraphMaxChars}, разбей на два или сократи`,
      );
    } else if (size > config.lint.paragraphWarnChars) {
      out.warn('paragraph_warn', `абзац на ${size} знаков: близко к кирпичу, лучше разбить`);
    }
    runCount += 1;
    runChars += size;
  }
  closeRun();
}

export function checkNumbers(visible: string, config: SmmConfig, out: Collector): void {
  const blocks = visible.split(/\n\s*\n/).filter((block) => block.trim() !== '');
  blocks.forEach((block, index) => {
    // Строки таблицы из подсчёта исключаются: таблица и существует ради того,
    // чтобы собрать числа в один читаемый блок.
    const prose = block
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('|'))
      .join('\n');
    const count = countNumbers(prose);
    if (count > config.lint.numbersPerParagraph) {
      out.error(
        'numbers_per_paragraph',
        `абзац ${index + 1}: ${count} чисел (цифрами и словами), больше ${config.lint.numbersPerParagraph} — перепиши`,
      );
    }
  });
}

export function checkAds(raw: string, cta: LintContext['cta'], out: Collector): void {
  const botCount = (raw.match(BOT_RE) ?? []).length;
  const brandCount = (raw.match(BRAND_RE) ?? []).length;
  const lines = raw.split('\n').map((line) => line.trim());
  const lastLine = lines.filter((line) => line !== '').at(-1) ?? '';

  if (cta === 'none') {
    if (botCount > 0 || brandCount > 0) {
      out.error(
        'cta_none_has_brand',
        'уровень рекламы none, а в тексте есть бот или бренд: убери упоминания или смени уровень',
      );
    }
    return;
  }
  if (cta === 'soft') {
    if (botCount > 1 || brandCount > 1) {
      out.error('cta_soft_repeats', 'уровень soft: бренд или бот упомянуты больше одного раза');
    }
    if (BOT_RE.test(lastLine) && lastLine.length < 60) {
      out.error(
        'cta_soft_call',
        'уровень soft: последняя строка выглядит отдельным призывом, вплети упоминание в текст',
      );
    }
    if (botCount === 0 && brandCount === 0) {
      out.warn('cta_soft_empty', 'уровень soft, но ни бота, ни бренда в тексте нет: это фактически none');
    }
    return;
  }
  // hard
  if (botCount === 0) {
    out.error('cta_hard_missing', 'уровень hard: нужен явный призыв в конце со ссылкой на бота');
  } else {
    const tail = lines.filter((line) => line !== '').slice(-3).join('\n');
    if (!BOT_RE.test(tail)) {
      out.warn('cta_hard_far', 'уровень hard: призыв не в последних трёх строках, читатель его не найдёт');
    }
    if (botCount > 1) {
      out.warn('cta_hard_repeats', 'бот упомянут больше одного раза: один призыв сильнее двух');
    }
  }
}

export function checkRedLines(raw: string, visible: string, out: Collector): void {
  const low = visible.toLowerCase();
  for (const rule of RED_LINES) {
    if (rule.re.test(low)) out.error(rule.code, rule.message);
  }
  const brandPresent = BRAND_RE.test(raw) || BOT_RE.test(raw);
  for (const rule of BRAND_SCOPED_RED_LINES) {
    if (!rule.re.test(low)) continue;
    if (brandPresent) out.error(rule.code, rule.message);
    else {
      // Про чужой сервис «сбой» законен: сплошной запрет заставлял автора
      // переписывать факт из источника ради регэкспа.
      out.warn('incident_foreign', 'слово про сбой или аварию: про чужой сервис можно, про Оплатишку нельзя');
    }
  }
  if (PAN_RE.test(raw)) out.error('red_line_pan', 'похоже на номер карты');

  for (const match of visible.matchAll(CARD_RE)) {
    const from = Math.max(0, (match.index ?? 0) - CARD_COUNTRY_WINDOW);
    const to = (match.index ?? 0) + match[0].length + CARD_COUNTRY_WINDOW;
    if (COUNTRY_RE.test(visible.slice(from, to))) {
      out.error('red_line_country', 'страна выпуска карты рядом со словом «карта»');
      break;
    }
  }
}

/**
 * Стиль, общий для канала и Threads: длинное тире, нейросетевые обороты,
 * подозрительные формулировки, «ничего не меняется», плоский голос и жаргон.
 * Читатель у площадок один и тот же человек с телефоном.
 */
export function checkStyleCommon(raw: string, visible: string, out: Collector): void {
  if (raw.includes('—')) {
    out.error('em_dash', 'в тексте длинное тире: замени на точку или запятую');
  }
  for (const rule of AI_PHRASES) {
    if (rule.re.test(visible)) out.error(rule.code, rule.message);
  }
  for (const rule of WARNING_PATTERNS) {
    if (rule.re.test(visible)) out.warn(rule.code, rule.message);
  }
  if (SO_WHAT_RE.test(visible)) {
    out.warn(
      'so_what',
      'вывод «для тебя ничего не меняется»: найди действие для читателя или предложи владельцу другую тему',
    );
  }
  if (!VOICE_RE.test(visible) && countEmoji(visible) === 0) {
    out.warn(
      'voice_flat',
      'текст звучит отчётом: ни живой связки, ни вопроса, ни ремарки — добавь хотя бы одну',
    );
  }
  const jargon = [...new Set([...visible.matchAll(JARGON_RE)].map((m) => m[0].toLowerCase()))];
  if (jargon.length > 0) {
    out.warn(
      'jargon',
      `технический жаргон для обычного читателя: ${jargon.join(', ')} — объясни бытовым словом или убери`,
    );
  }
}

/** Стиль, свойственный только каналу: маркер выделения и потолок эмодзи на пост. */
function checkChannelStyle(raw: string, visible: string, config: SmmConfig, out: Collector): void {
  if (raw.includes('==')) {
    out.error(
      'marker_highlight',
      'выделение маркером (==текст==) запрещено: в тёмной теме текст под заливкой не читается',
    );
  }
  const emoji = countEmoji(visible);
  if (emoji > config.lint.emojiMax) {
    out.error('emoji_max', `эмодзи ${emoji}, потолок ${config.lint.emojiMax}`);
  }
}

function checkBlocks(raw: string, config: SmmConfig, out: Collector): void {
  const present = SPECIAL_BLOCK_PATTERNS.filter((rule) => rule.re.test(raw));
  if (present.length > config.lint.specialBlocksMax) {
    out.error(
      'special_blocks',
      `особых блоков ${present.length} (${present.map((p) => p.code).join(', ')}), ` +
        `в посте максимум ${config.lint.specialBlocksMax}`,
    );
  }
  for (const table of tables(raw)) {
    if (table.columns > config.lint.tableMaxCols) {
      out.error(
        'table_cols',
        `в таблице ${table.columns} колонки: на телефоне читается до ${config.lint.tableMaxCols}`,
      );
    }
    if (table.rows.length > config.lint.tableMaxRows) {
      out.error(
        'table_rows',
        `в таблице ${table.rows.length} строк вместе с шапкой: оставь до ${config.lint.tableMaxRows}`,
      );
    }
  }
  const markers = raw.split(IMAGE_MARKER).length - 1;
  if (markers > 1) {
    out.error('image_marker', `маркер ${IMAGE_MARKER} стоит ${markers} раза, картинка в посте одна`);
  }
}

/**
 * Свежесть: повторы относительно последних постов площадки.
 *
 * Без этой проверки автор воспроизводил образцы скилла и свои же прошлые посты
 * почти дословно — регэксп голоса хвалил ровно эти фразы.
 */
export function checkFreshness(
  raw: string,
  previous: readonly PreviousPost[],
  config: SmmConfig,
  out: Collector,
): void {
  if (previous.length === 0) return;
  const visible = visibleText(raw);
  const low = visible.toLowerCase();
  const window = previous.slice(0, config.lint.freshnessWindow);
  const seen = new Set<string>();

  for (const post of window) {
    const prevVisible = visibleText(post.body);
    const prevLow = prevVisible.toLowerCase();
    for (const phrase of config.lint.stockPhrases) {
      if (low.includes(phrase) && prevLow.includes(phrase)) {
        const code = `freshness_phrase:${phrase}`;
        if (seen.has(code)) continue;
        seen.add(code);
        out.error('freshness_phrase', `«${phrase}» уже было в ${post.id}: найди другую связку`);
      }
    }
    const common = [...sentences(visible)].filter((s) => sentences(prevVisible).has(s));
    for (const sentence of common.sort().slice(0, 2)) {
      out.error('freshness_sentence', `фраза дословно из ${post.id}: «${sentence.slice(0, 60)}…»`);
    }
  }

  const head = opener(headline(raw));
  if (head !== '') {
    for (const post of previous.slice(0, 10)) {
      if (opener(headline(post.body)) === head) {
        out.error(
          'freshness_opener',
          `заголовок начинается так же, как в ${post.id}: «${head}»`,
        );
        break;
      }
    }
  }

  const emoji = closingEmoji(visible);
  if (
    emoji !== '' &&
    previous.length >= 2 &&
    previous.slice(0, 2).every((post) => closingEmoji(visibleText(post.body)) === emoji)
  ) {
    out.warn('freshness_ending', `третий пост подряд заканчивается ${emoji}: смени концовку`);
  }

  const form = shape(raw);
  if (
    previous.length >= 3 &&
    previous.slice(0, 3).every((post) => {
      const prev = shape(post.body);
      return prev.hasH2 === form.hasH2 && prev.hasList === form.hasList;
    })
  ) {
    out.warn(
      'freshness_shape',
      'четвёртый пост подряд с той же раскладкой: смени форму — например заголовок, лид и один абзац',
    );
  }
}

export function lintPost(body: string, ctx: LintContext): LintResult {
  const config = ctx.config ?? smmConfig;
  const out = new Collector();
  const raw = body.trim();
  if (raw === '') {
    out.error('empty', 'пустой текст');
    return out.result();
  }
  const visible = visibleText(raw);
  const layout = config.layouts[ctx.layout];

  checkHeadline(raw, out);
  checkLayout(raw, layout, out);
  checkLength(visible, layout, config, out);
  checkWall(raw, config, out);
  checkNumbers(visible, config, out);
  checkAds(raw, ctx.cta, out);
  checkRedLines(raw, visible, out);
  checkStyleCommon(raw, visible, out);
  checkChannelStyle(raw, visible, config, out);
  checkBlocks(raw, config, out);
  if (ctx.hasImage === false && raw.includes(IMAGE_MARKER)) {
    out.error(
      'image_marker_without_file',
      `маркер ${IMAGE_MARKER} стоит, а картинки у поста нет: убери маркер`,
    );
  }
  checkFreshness(raw, ctx.previous ?? [], config, out);

  return out.result();
}

export { Collector };
