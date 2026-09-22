import { describe, expect, it } from 'vitest';

import { lintPost, lintThreads } from './index.ts';
import { BOT_RE, BRAND_RE, countMatches } from './rules.ts';
import { sentences, tables, visibleLength } from './text.ts';
import type { LintContext, LintResult, PreviousPost, ThreadsLintContext } from './types.ts';

/**
 * Дыры, названные ревью тикета 04. Каждая проверка объясняет, какой отказ она
 * закрывает: ложное срабатывание на обычном русском стоит двух кругов правок, а
 * мёртвое правило молча пропускает то, ради чего оно написано.
 */

function codes(result: LintResult): { errors: string[]; warnings: string[] } {
  return {
    errors: result.errors.map((f) => f.code),
    warnings: result.warnings.map((f) => f.code),
  };
}

function ctx(overrides: Partial<LintContext> = {}): LintContext {
  return { layout: 'a', cta: 'none', hasImage: true, ...overrides };
}

function threadsCtx(overrides: Partial<ThreadsLintContext> = {}): ThreadsLintContext {
  return { cta: 'none', ...overrides };
}

const POST = (body: string): string =>
  `# Заголовок утверждает факт для читателя\n\n${body}\n\nЧто делать: проверить у себя и не переплачивать за лишнее сегодня.`;

describe('ложные срабатывания на обычном русском', () => {
  it('«загрузи карту» — не страна выпуска карты', () => {
    // Регэксп потерял границу слова у «грузи», и любой пост-инструкция про
    // загрузку карты гарантированно не проходил гейт.
    const errors = codes(lintPost(POST('Загрузи карту в приложение и оплати подписку одним касанием.'), ctx())).errors;
    expect(errors).not.toContain('red_line_country');
  });

  it('«Грузия» страной остаётся', () => {
    const errors = codes(
      lintPost(POST('Карту выпускают в Грузии, и это видно в приложении банка сразу.'), ctx()),
    ).errors;
    expect(errors).toContain('red_line_country');
  });

  it('«скрипт» — не крипта', () => {
    const warnings = codes(lintPost(POST('Скрипт на питоне соберёт таблицу за тебя за минуту.'), ctx())).warnings;
    expect(warnings).not.toContain('warn_crypto');
  });

  it('«миграция птиц» — не внутренняя кухня', () => {
    const errors = codes(lintPost(POST('Модель разобрала данные про миграцию птиц за пару секунд.'), ctx())).errors;
    expect(errors).not.toContain('red_line_internals');
  });

  it('«миграция на новую модель» тоже не ошибка, а вот деплой — ошибка', () => {
    expect(codes(lintPost(POST('Деплой нового сайта занял пару минут.'), ctx())).errors).toContain(
      'red_line_internals',
    );
  });
});

describe('красные линии по тикету', () => {
  it('цена в рублях — ошибка, а не предупреждение', () => {
    const result = lintPost(POST('Подписка стоит 1200 рублей в месяц, если брать на год.'), ctx());
    expect(codes(result).errors).toContain('red_line_rub_price');
    expect(codes(result).warnings).not.toContain('warn_rub_price');
  });

  it('курс цифрой — ошибка', () => {
    expect(codes(lintPost(POST('Курс 95 за доллар держится вторую неделю подряд.'), ctx())).errors).toContain(
      'red_line_rate',
    );
  });
});

describe('реклама', () => {
  it('имя бота в теле — ошибка: ссылку несёт кнопка', () => {
    expect(codes(lintPost(POST('Пиши сюда: @oplatishkaa_bot'), ctx({ cta: 'hard' }))).errors).toContain(
      'bot_in_body',
    );
  });

  it('счёт упоминаний не зависит от предыдущих вызовов', () => {
    // Регулярки с флагом `g` помнят lastIndex между вызовами: один и тот же
    // текст давал то true, то false, и наружу утекала грязная регулярка.
    const text = 'Оплатишка и ещё раз Оплатишка';
    expect(countMatches(BRAND_RE, text)).toBe(2);
    expect(countMatches(BRAND_RE, text)).toBe(2);
    expect(BRAND_RE.test(text)).toBe(true);
    expect(BRAND_RE.test(text)).toBe(true);
    expect(BOT_RE.flags).not.toContain('g');
    expect(BRAND_RE.flags).not.toContain('g');
  });
});

describe('пометка о Meta', () => {
  it('упоминание Threads в посте канала требует пометки', () => {
    // Ст. 13.15 КоАП. Правило было в прошлом контуре и терялось при переносе.
    const warnings = codes(lintPost(POST('Мы завели аккаунт в Threads и пишем там короче.'), ctx())).warnings;
    expect(warnings).toContain('meta_disclaimer');
  });

  it('с пометкой предупреждения нет', () => {
    const body = POST('Мы завели аккаунт в Threads (сеть принадлежит Meta, признанной экстремистской и запрещённой в РФ).');
    expect(codes(lintPost(body, ctx())).warnings).not.toContain('meta_disclaimer');
  });
});

describe('версии моделей', () => {
  it('индекс версии — предупреждение', () => {
    const warnings = codes(lintPost(POST('Gemini 2.5 отвечает быстрее прошлой версии на длинных текстах.'), ctx())).warnings;
    expect(warnings).toContain('model_version');
  });

  it('человеческое имя модели предупреждения не даёт', () => {
    const warnings = codes(lintPost(POST('Новая модель Google отвечает быстрее прошлой на длинных текстах.'), ctx())).warnings;
    expect(warnings).not.toContain('model_version');
  });
});

describe('особые блоки считаются штуками', () => {
  it('две таблицы подряд — ошибка, даже если вид один', () => {
    const body = `# Заголовок отвечает на вопрос, что выбрать

Лид про задачу читателя: нужно выбрать между двумя сервисами и не переплатить.

| Сервис | Цена |
|---|---|
| Первый | 20 |

Абзац между таблицами про то, зачем вторая таблица вообще нужна читателю.

| Сервис | Лимит |
|---|---|
| Второй | 100 |

Кому что: бери первый, если пишешь каждый день.`;
    expect(codes(lintPost(body, ctx({ layout: 'g' }))).errors).toContain('special_blocks');
  });

  it('две раскрывашки — тоже ошибка', () => {
    const body = POST('<details><summary>Раз</summary>тело</details>\n\n<details><summary>Два</summary>тело</details>');
    expect(codes(lintPost(body, ctx({ layout: 'b' }))).errors).toContain('special_blocks');
  });
});

describe('разбор таблицы и длины', () => {
  it('экранированная черта внутри ячейки не считается колонкой', () => {
    const table = '| a \\| b | c |\n|---|---|\n| 1 | 2 |';
    expect(tables(table)[0]?.columns).toBe(2);
  });

  it('длина считается по кодовым точкам, а не по единицам UTF-16', () => {
    expect(visibleLength('текст 🎉')).toBe(7);
    expect('текст 🎉'.length).toBe(8);
  });
});

describe('свежесть по площадкам', () => {
  const threadsPrevious: PreviousPost[] = [
    { id: 'thr-1', body: 'Gemini помнит разговоры месяц. Это меняет работу с чатом полностью.' },
  ];

  it('повтор зачина Threads ловится по ПЕРВОЙ СТРОКЕ', () => {
    // Заголовка `#` у Threads нет вовсе, и безусловный headline молча
    // выключал правило на всей площадке.
    const body = 'Gemini помнит теперь и вложения. Совсем другой текст без общих фраз (проверено).';
    expect(codes(lintThreads(body, threadsCtx({ previous: threadsPrevious }))).errors).toContain(
      'freshness_opener',
    );
  });

  it('предупреждения о повторе формы на Threads нет', () => {
    // Ни подзаголовков, ни списков там нет по правилам площадки: правило
    // срабатывало бы на каждом посте.
    const previous: PreviousPost[] = [
      { id: 't1', body: 'Первый пост площадки про одно (и это заметно).' },
      { id: 't2', body: 'Второй пост площадки про другое (и это тоже заметно).' },
      { id: 't3', body: 'Третий пост площадки про третье (и снова заметно).' },
    ];
    const body = 'Четвёртый пост про совсем иное, без общих фраз с прошлыми (и это важно).';
    expect(codes(lintThreads(body, threadsCtx({ previous }))).warnings).not.toContain('freshness_shape');
  });

  it('пункт списка, повторённый дословно, ловится как фраза', () => {
    const previous: PreviousPost[] = [
      {
        id: 'p1',
        body: '# Прошлый пост\n\n- **Базовый.** Хватает, если пишешь письма и переводишь короткие тексты.\n- **Платный.** Нужен для таблиц.',
      },
    ];
    const body = `# Новый пост про тарифы сервиса

Лид про задачу читателя и что изменилось за последнюю неделю в тарифах.

## Сколько стоит

- **Базовый.** Хватает, если пишешь письма и переводишь короткие тексты.
- **Платный.** Нужен для таблиц и длинных документов каждый день.
- **Командный.** Нужен, если вас больше трёх человек в проекте.

Итог: начни с бесплатного и посмотри, чего не хватает.`;
    expect(codes(lintPost(body, ctx({ layout: 'b', previous }))).errors).toContain('freshness_sentence');
  });

  it('одна и та же фраза из нескольких постов печатается один раз', () => {
    const shared = 'Проверить можно за минуту в приложении на телефоне сегодня.';
    const previous: PreviousPost[] = [
      { id: 'p1', body: `# Первый\n\n${shared}` },
      { id: 'p2', body: `# Второй\n\n${shared}` },
      { id: 'p3', body: `# Третий\n\n${shared}` },
    ];
    const body = POST(shared);
    const found = codes(lintPost(body, ctx({ previous }))).errors.filter(
      (code) => code === 'freshness_sentence',
    );
    expect(found).toHaveLength(1);
  });

  it('предложения разбираются и по строкам, и по абзацам', () => {
    const list = 'первый достаточно длинный пункт списка тут\nвторой достаточно длинный пункт списка тут';
    expect(sentences(list).size).toBeGreaterThanOrEqual(2);
  });
});

describe('правила Threads', () => {
  it('слово «акция» ловится как реклама по 72-ФЗ', () => {
    // Ветка была мертва: `\bакци[яию]\b` в JS не матчится на кириллице.
    expect(codes(lintThreads('Наша акция до конца дня, успевай (и это правда).', threadsCtx())).errors).toContain(
      'threads_ad',
    );
  });

  it('ссылка в скобках тоже считается ссылкой', () => {
    const body = 'Короткий пост про память (t.me/oplatishkaa_bot) и ещё пара слов сверху.';
    expect(codes(lintThreads(body, threadsCtx())).errors).toContain('threads_link_first');
  });

  it('«участь» нумерацией цепочки не считается', () => {
    const body = 'Участь 5 сервисов решится на этой неделе, и вот почему это важно.';
    expect(codes(lintThreads(body, threadsCtx())).errors).not.toContain('threads_numbering');
  });

  it('«часть 2» как нумерация цепочки ловится', () => {
    expect(codes(lintThreads('Часть 2 разбора про память (и это важно).', threadsCtx())).errors).toContain(
      'threads_numbering',
    );
  });
});

describe('заголовок и картинка', () => {
  it('ведущая картинка не считается текстом перед заголовком', () => {
    const body = `![](cover.png)\n\n${POST('Обычный абзац про то, что изменилось.')}`;
    expect(codes(lintPost(body, ctx())).errors).not.toContain('h1_not_first');
  });
});
