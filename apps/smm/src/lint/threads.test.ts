import { describe, expect, it } from 'vitest';

import { threadsIntentUrl } from '../threads/intent.ts';
import { lintThreads, threadsHook, threadsLength, threadsPieces } from './index.ts';
import type { LintResult, PreviousPost, ThreadsLintContext } from './types.ts';

function codes(result: LintResult): { errors: string[]; warnings: string[] } {
  return {
    errors: result.errors.map((f) => f.code),
    warnings: result.warnings.map((f) => f.code),
  };
}

function ctx(overrides: Partial<ThreadsLintContext> = {}): ThreadsLintContext {
  return { cta: 'none', ...overrides };
}

/** Одиночный пост, проходящий линт площадки. */
const GOOD =
  'Gemini помнит прошлые разговоры даже без подписки.\n' +
  'Проверить просто: спроси о том, что обсуждал вчера (и посмотри, вспомнит ли детали).';

describe('годный пост Threads', () => {
  it('проходит без ошибок', () => {
    expect(codes(lintThreads(GOOD, ctx())).errors).toEqual([]);
  });

  it('разбор на части и длина считаются по правилам площадки', () => {
    expect(threadsPieces(`первая\n---\nвторая`)).toEqual(['первая', 'вторая']);
    expect(threadsHook('Крючок первой строкой\nи продолжение')).toBe('Крючок первой строкой');
    // Эмодзи считается за четыре знака: API площадки считает байтами UTF-8.
    expect(threadsLength('текст')).toBe(5);
    // Семь кодовых точек («текст » плюс эмодзи) и вес: эмодзи считается за
    // четыре знака, то есть добавляет три сверх собственной единицы.
    expect(threadsLength('текст 🎉')).toBe(7 + 3);
  });
});

describe('правила площадки', () => {
  it('решётка в тексте — ошибка (тему задаёт параметр)', () => {
    expect(codes(lintThreads(`${GOOD} #ии`, ctx())).errors).toContain('threads_hash');
  });

  it('разметка markdown — ошибка', () => {
    expect(codes(lintThreads(`**Важно.** ${GOOD}`, ctx())).errors).toContain('threads_markup');
    expect(codes(lintThreads(`## Заголовок\n${GOOD}`, ctx())).errors).toContain('threads_markup');
  });

  it('часть длиннее потолка — ошибка', () => {
    const long = 'а'.repeat(500);
    expect(codes(lintThreads(long, ctx())).errors).toContain('threads_piece_length');
  });

  it('шестая часть — ошибка', () => {
    const chain = Array.from({ length: 6 }, (_, i) => `Часть про дело номер ${i}`).join('\n---\n');
    expect(codes(lintThreads(chain, ctx())).errors).toContain('threads_pieces_max');
  });

  it('четыре части — предупреждение', () => {
    const chain = Array.from({ length: 4 }, (_, i) => `Часть про дело номер ${i}`).join('\n---\n');
    const result = lintThreads(chain, ctx());
    expect(codes(result).warnings).toContain('threads_pieces_warn');
    expect(codes(result).errors).not.toContain('threads_pieces_max');
  });

  it('крючок длиннее лимита — ошибка', () => {
    const hook = `${'Очень длинный крючок про то, что произошло и почему это важно читателю сегодня'.repeat(2)}`;
    expect(codes(lintThreads(hook, ctx())).errors).toContain('threads_hook_long');
  });

  it('ссылка в первом посте — ошибка', () => {
    const body = `${GOOD} https://example.com/post`;
    expect(codes(lintThreads(body, ctx())).errors).toContain('threads_link_first');
  });

  it('ссылка не в последней части — ошибка', () => {
    const body = `${GOOD}\n---\nСередина со ссылкой https://example.com/post\n---\nКонец цепочки тут`;
    expect(codes(lintThreads(body, ctx())).errors).toContain('threads_link_middle');
  });

  it('ссылка в последней части — законно', () => {
    const body = `${GOOD}\n---\nПодробности в блоге: https://example.com/post`;
    const errors = codes(lintThreads(body, ctx())).errors;
    expect(errors).not.toContain('threads_link_first');
    expect(errors).not.toContain('threads_link_middle');
    expect(errors).not.toContain('threads_link_count');
  });

  it('две ссылки на цепочку — ошибка', () => {
    const body = `${GOOD}\n---\nПервая https://a.example.com и вторая https://b.example.com`;
    expect(codes(lintThreads(body, ctx())).errors).toContain('threads_link_count');
  });

  it('нумерация «1/5» — ошибка', () => {
    expect(codes(lintThreads(`1/5 ${GOOD}`, ctx())).errors).toContain('threads_numbering');
  });

  it('выпрашивание реакций — ошибка', () => {
    expect(codes(lintThreads(`${GOOD} Ставьте лайк, если согласны`, ctx())).errors).toContain(
      'threads_bait',
    );
  });

  it('реклама по 72-ФЗ — ошибка', () => {
    expect(codes(lintThreads(`${GOOD} Промокод на скидку внутри`, ctx())).errors).toContain(
      'threads_ad',
    );
  });

  it('больше трёх эмодзи в части — ошибка', () => {
    expect(codes(lintThreads(`${GOOD} 🎉🎉🎉🎉`, ctx())).errors).toContain('threads_emoji');
  });

  it('негодная тема — ошибка', () => {
    expect(codes(lintThreads(GOOD, ctx({ tag: 'тема.с.точкой' }))).errors).toContain('threads_tag');
    expect(codes(lintThreads(GOOD, ctx({ tag: 'и'.repeat(60) }))).errors).toContain('threads_tag');
  });

  it('пост, не влезающий в кнопку Threads, — ошибка', () => {
    // Кириллица в percent-encoding это шесть знаков на букву, поэтому адрес
    // кнопки упирается в потолок на длинном тексте. Правило — второй эшелон:
    // часть, влезающая в лимит площадки, в кнопку влезает всегда.
    const cyrillic = 'я'.repeat(700);
    const errors = codes(lintThreads(cyrillic, ctx())).errors;
    expect(errors).toContain('threads_intent_long');
    expect(errors).toContain('threads_piece_length');
    expect(threadsIntentUrl(cyrillic).length).toBeGreaterThan(4000);
  });

  it('капс в крючке — предупреждение', () => {
    const body = `ВАЖНО СРОЧНО ВСЕМ читать про память Gemini прямо сейчас (это правда)`;
    expect(codes(lintThreads(body, ctx())).warnings).toContain('threads_hook_caps');
  });
});

describe('общие правила канала действуют и здесь', () => {
  it('длинное тире — ошибка', () => {
    expect(codes(lintThreads(`${GOOD} Это важно — и вот почему`, ctx())).errors).toContain('em_dash');
  });

  it('красная линия — ошибка', () => {
    expect(
      codes(lintThreads('Оплату принимает Freekassa, и это удобно всем сторонам', ctx())).errors,
    ).toContain('red_line_provider');
  });

  it('cta none и упоминание бренда — ошибка', () => {
    expect(codes(lintThreads(`${GOOD} Оплатишка поможет`, ctx({ cta: 'none' }))).errors).toContain(
      'cta_none_has_brand',
    );
  });

  it('нейросетевой оборот — ошибка', () => {
    expect(codes(lintThreads(`Это прорыв. ${GOOD}`, ctx())).errors).toContain(
      'ai_phrase_breakthrough',
    );
  });
});

describe('копипаста из канала', () => {
  const channelPrevious: PreviousPost[] = [
    {
      id: 'post-1',
      body: `# Google раздала память Gemini бесплатным пользователям

Gemini теперь помнит прошлые разговоры даже на бесплатном аккаунте и не просит
пересказывать вчерашнее заново.`,
    },
  ];

  it('предложение дословно из поста канала — ошибка', () => {
    const body = 'Gemini теперь помнит прошлые разговоры даже на бесплатном аккаунте и не просит пересказывать вчерашнее заново.';
    expect(codes(lintThreads(body, ctx({ channelPrevious }))).errors).toContain(
      'threads_channel_copy',
    );
  });

  it('свой текст по тому же досье — законно', () => {
    const body = 'Спроси Gemini о вчерашнем разговоре: теперь вспоминает сам, даже без подписки (проверено).';
    expect(codes(lintThreads(body, ctx({ channelPrevious }))).errors).not.toContain(
      'threads_channel_copy',
    );
  });
});

describe('адрес Web Intent', () => {
  it('собирается с текстом и темой, без параметра url', () => {
    const url = threadsIntentUrl('Привет, мир', 'ии');
    expect(url.startsWith('https://www.threads.com/intent/post?')).toBe(true);
    expect(url).toContain('tag=%D0%B8%D0%B8');
    // Плюс вместо пробела Threads показал бы буквально.
    expect(url).not.toContain('+');
    expect(url).not.toContain('url=');
  });

  it('без темы параметра tag нет', () => {
    expect(threadsIntentUrl('Привет')).not.toContain('tag=');
  });
});

describe('пустой текст', () => {
  it('одна ошибка «пустой текст»', () => {
    expect(codes(lintThreads('  ', ctx())).errors).toEqual(['empty']);
  });
});
