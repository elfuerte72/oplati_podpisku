import { smmConfig } from '../config/smm.config.ts';
import { threadsIntentUrl } from '../threads/intent.ts';
import {
  checkAds,
  checkFreshness,
  checkNumbers,
  checkRedLines,
  checkStyleCommon,
  Collector,
} from './post.ts';
import {
  THREADS_AD_RE,
  THREADS_BAIT_RE,
  THREADS_HASH_RE,
  THREADS_MARKUP_RE,
  THREADS_NUMBERING_RE,
  THREADS_TAG_BAD_RE,
  URL_RE,
} from './threads-rules.ts';
import { countEmoji, visibleText } from './text.ts';
import type { LintResult, PreviousPost, ThreadsLintContext } from './types.ts';

/**
 * Линт поста для Threads. Правила площадки, а не канала: заголовка нет,
 * разметки нет, ссылка только в последнем ответе, реакции не выпрашиваются.
 *
 * Общие правила (реклама по уровню, числа, красные линии, жаргон, живой голос)
 * те же: читатель — тот же человек с телефоном.
 */

/** Части поста: первая — сам пост, остальные — ответы-продолжения. */
export function threadsPieces(text: string, separator = smmConfig.threads.separator): string[] {
  // Разделитель экранируется: это настройка конфига, и `***` иначе стал бы
  // регулярным выражением вместо строки.
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*$`, 'm');
  return text
    .trim()
    .split(re)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');
}

/**
 * Длина части по правилам Threads: эмодзи считается за четыре знака.
 * Лимит площадки 500, но API считает эмодзи байтами UTF-8, а приложение —
 * неизвестно как; потолок 480 с весом 4 — запас на это расхождение.
 */
export function threadsLength(piece: string, weight = smmConfig.threads.emojiWeight): number {
  // Длина считается по КОДОВЫМ ТОЧКАМ: эмодзи в UTF-16 занимает две единицы, и
  // `piece.length` считал бы его дважды ещё до применения веса.
  return [...piece].length + (weight - 1) * countEmoji(piece);
}

/** Крючок: первая непустая строка первой части. Заголовка у Threads нет. */
export function threadsHook(text: string): string {
  const [first] = threadsPieces(text);
  if (first === undefined) return '';
  return first.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** Длинные предложения: грубая проверка на копипасту между площадками. */
function longSentences(visible: string, minWords = 8): Set<string> {
  const out = new Set<string>();
  // Как и у свежести: сначала абзацы, потом предложения. Переносы внутри
  // абзаца схлопываются — в посте канала та же фраза свёрнута иначе.
  for (const block of visible.split(/\n\s*\n/)) {
    const flat = block.toLowerCase().replace(/\s+/g, ' ');
    for (const part of flat.split(/(?<=[.!?])\s+/)) {
      const clean = part.replace(/^[\s.!?«»"]+|[\s.!?«»"]+$/g, '');
      if ((clean.match(/[а-яёa-z0-9]+/g) ?? []).length >= minWords) out.add(clean);
    }
  }
  return out;
}

export function lintThreads(text: string, ctx: ThreadsLintContext): LintResult {
  const config = ctx.config ?? smmConfig;
  const limits = config.threads;
  const out = new Collector();
  const raw = text.trim();
  if (raw === '') {
    out.error('empty', 'пустой текст');
    return out.result();
  }

  const pieces = threadsPieces(raw, limits.separator);
  if (pieces.length > limits.maxPieces) {
    out.error(
      'threads_pieces_max',
      `частей ${pieces.length}, потолок ${limits.maxPieces}: пост и до четырёх ответов, остальное — другой пост`,
    );
  } else if (pieces.length > limits.piecesWarn) {
    out.warn(
      'threads_pieces_warn',
      `частей ${pieces.length}: цепочки длиннее трёх читают хуже, проверь, что каждая часть нужна`,
    );
  }

  pieces.forEach((piece, index) => {
    const number = index + 1;
    const length = threadsLength(piece, limits.emojiWeight);
    if (length > limits.pieceLimit) {
      out.error(
        'threads_piece_length',
        `часть ${number}: ${length} знаков (эмодзи за ${limits.emojiWeight}), потолок ${limits.pieceLimit}`,
      );
    } else if (index === 0 && length > limits.postTarget) {
      out.warn(
        'threads_post_target',
        `первый пост ${length} знаков: лучше всего читают до ${limits.postTarget}`,
      );
    } else if (index > 0 && length > limits.replyTarget) {
      out.warn('threads_reply_target', `часть ${number}: ${length} знаков, ответ лучше держать до ${limits.replyTarget}`);
    }

    const hashes = piece.match(THREADS_HASH_RE) ?? [];
    if (hashes.length > 0) {
      out.error(
        'threads_hash',
        `часть ${number}: решётка в тексте (${hashes.slice(0, 3).join(', ')}); тему задаёт параметр тега`,
      );
    }

    const markup = THREADS_MARKUP_RE.exec(piece);
    if (markup !== null) {
      out.error(
        'threads_markup',
        `часть ${number}: разметка «${(markup[0] ?? '').trim()}», Threads покажет её буквально`,
      );
    }

    const emoji = countEmoji(piece);
    if (emoji > limits.emojiMax) {
      out.error('threads_emoji', `часть ${number}: эмодзи ${emoji}, потолок ${limits.emojiMax}`);
    }

    if (THREADS_NUMBERING_RE.test(piece)) {
      out.error(
        'threads_numbering',
        `часть ${number}: нумерация «1/…» или «часть N» — Threads сам показывает, что это цепочка`,
      );
    }

    const bait = THREADS_BAIT_RE.exec(piece);
    if (bait !== null) {
      out.error(
        'threads_bait',
        `часть ${number}: «${bait[0]}» — выпрашивание реакций, площадка режет за это охват`,
      );
    }

    const ad = THREADS_AD_RE.exec(piece);
    if (ad !== null) {
      out.error(
        'threads_ad',
        `часть ${number}: «${ad[0]}» — это реклама по 72-ФЗ, на площадках Meta она запрещена`,
      );
    }
  });

  const hook = threadsHook(raw);
  if (hook.length > limits.hookMax) {
    out.error(
      'threads_hook_long',
      `первая строка ${hook.length} знаков: лента показывает её обрезанной, крючок обязан влезать в ${limits.hookMax}`,
    );
  }
  const caps = hook.match(/[А-ЯЁA-Z]{3,}/g) ?? [];
  if (caps.length >= 3) {
    out.warn('threads_hook_caps', 'первая строка капсом: у канала не крикливый голос');
  }

  const urlsByPiece = pieces.map((piece) => piece.match(URL_RE) ?? []);
  if (pieces.length > 0 && (urlsByPiece[0] ?? []).length > 0) {
    out.error(
      'threads_link_first',
      'ссылка в первом посте: такие посты собирают меньше реакций, ссылку клади в последний ответ',
    );
  }
  urlsByPiece.slice(1, -1).forEach((urls, index) => {
    if (urls.length > 0) {
      out.error('threads_link_middle', `часть ${index + 2}: ссылка не в последнем ответе`);
    }
  });
  const totalUrls = urlsByPiece.reduce((sum, urls) => sum + urls.length, 0);
  if (totalUrls > 1) {
    out.error('threads_link_count', `ссылок ${totalUrls}: в цепочке одна, и она в последнем ответе`);
  }

  const first = pieces[0];
  if (first !== undefined) {
    const intent = threadsIntentUrl(first, ctx.tag, config);
    if (intent.length > limits.intentUrlMax) {
      out.error(
        'threads_intent_long',
        `первый пост не влезает в кнопку Threads (адрес длиннее ${limits.intentUrlMax} знаков): сократи его`,
      );
    }
  }

  if (ctx.tag !== undefined && ctx.tag !== '') {
    if (ctx.tag.length > limits.tagMax || THREADS_TAG_BAD_RE.test(ctx.tag)) {
      out.error(
        'threads_tag',
        `тема «${ctx.tag}»: до ${limits.tagMax} знаков, без точки, амперсанда и переносов`,
      );
    }
  }

  const visible = pieces.join('\n\n');
  checkStyleCommon(visible, visible, out);
  checkAds(visible, ctx.cta, out);
  checkNumbers(visible, config, out);
  checkRedLines(visible, visible, out);
  // Свежесть считается по правилам ПЛОЩАДКИ: зачин у Threads — первая строка,
  // а правило повтора формы здесь бессмысленно (ни подзаголовков, ни списков).
  checkFreshness(raw, ctx.previous ?? [], config, out, {
    head: (body) => threadsHook(body),
    checkShape: false,
  });
  checkChannelCopy(visible, ctx.channelPrevious ?? [], config.lint.freshnessWindow, out);

  return out.result();
}

/**
 * Копипаста из поста канала. Threads официально режет охват неоригинальному, а
 * читатель, который видит обе площадки, узнаёт дубль.
 */
function checkChannelCopy(
  visible: string,
  channelPrevious: readonly PreviousPost[],
  window: number,
  out: Collector,
): void {
  const mine = longSentences(visible);
  for (const post of channelPrevious.slice(0, window)) {
    const theirs = longSentences(visibleText(post.body));
    const common = [...mine].filter((sentence) => theirs.has(sentence));
    const first = common.sort()[0];
    if (first !== undefined) {
      out.error(
        'threads_channel_copy',
        `предложение дословно из поста канала ${post.id}: «${first.slice(0, 60)}…». ` +
          'Перепиши для площадки своими словами',
      );
      return;
    }
  }
}
