import { describe, expect, it } from 'vitest';

import { formatLint, lintPassed, lintPost } from './index.ts';
import type { LintContext, LintResult, PreviousPost } from './types.ts';

/** Коды находок: тесты держатся за них, а не за формулировки сообщений. */
function codes(result: LintResult): { errors: string[]; warnings: string[] } {
  return {
    errors: result.errors.map((f) => f.code),
    warnings: result.warnings.map((f) => f.code),
  };
}

function ctx(overrides: Partial<LintContext> = {}): LintContext {
  return { layout: 'a', cta: 'none', hasImage: true, ...overrides };
}

/** Короткая новость, проходящая линт: от неё отсчитываются остальные фикстуры. */
const GOOD_A = `# Google раздала память Gemini бесплатным пользователям

Раньше приходилось каждый раз пересказывать, о чём шла речь вчера. Теперь
помощник помнит прошлые разговоры сам (и это заметно в первом же вопросе).

Проверить можно за минуту: открой приложение и спроси о том, что обсуждал
неделю назад. Если помнит, значит функция уже дошла до твоего аккаунта.

Оговорка: в блоге не сказано, работает ли это в России.`;

describe('годный пост', () => {
  it('проходит линт без ошибок', () => {
    const result = lintPost(GOOD_A, ctx());
    expect(codes(result).errors).toEqual([]);
    expect(lintPassed(result)).toBe(true);
  });

  it('линт детерминирован: один вход — один вывод', () => {
    // Внутри правил нет часов и нет обращений к базе, поэтому повтор обязан
    // давать ровно то же самое.
    const first = lintPost(GOOD_A, ctx());
    const second = lintPost(GOOD_A, ctx());
    expect(second).toEqual(first);
  });
});

describe('заголовок', () => {
  it('без заголовка — ошибка', () => {
    expect(codes(lintPost('Просто текст без заголовка.', ctx())).errors).toContain('no_h1');
  });

  it('заголовок не первой строкой — ошибка', () => {
    const body = `Вступление перед заголовком.

# Заголовок

Тело.`;
    expect(codes(lintPost(body, ctx())).errors).toContain('h1_not_first');
  });

  it('два заголовка первого уровня — ошибка', () => {
    const body = `# Первый

Тело.

# Второй`;
    expect(codes(lintPost(body, ctx())).errors).toContain('multiple_h1');
  });

  it('пустой зачин заголовка — ошибка', () => {
    const body = GOOD_A.replace(
      '# Google раздала память Gemini бесплатным пользователям',
      '# Друзья, сегодня про память Gemini',
    );
    expect(codes(lintPost(body, ctx())).errors).toContain('empty_opener');
  });

  it('заголовок без сказуемого — предупреждение, а не ошибка', () => {
    // Морфологии у нас нет: эвристика не должна ронять пост.
    const body = GOOD_A.replace(
      '# Google раздала память Gemini бесплатным пользователям',
      '# Про память Gemini',
    );
    const result = lintPost(body, ctx());
    expect(codes(result).warnings).toContain('headline_no_verb');
    expect(codes(result).errors).not.toContain('headline_no_verb');
  });
});

describe('раскладка', () => {
  it('А не терпит подзаголовок и список', () => {
    const body = `# Заголовок целиком утверждает факт

Лид про то, что изменилось для читателя и почему это важно сегодня.

## Подзаголовок

- первый пункт
- второй пункт
- третий пункт`;
    const errors = codes(lintPost(body, ctx({ layout: 'a' }))).errors;
    expect(errors).toContain('layout_h2_forbidden');
    expect(errors).toContain('layout_bullets_forbidden');
  });

  it('Б требует ровно один подзаголовок и от трёх до пяти пунктов', () => {
    const tooFew = `# Разбор нового тарифа показывает простую вещь

Лид про задачу читателя и что изменилось в тарифах за последнюю неделю.

## Сколько стоит

- **Базовый.** Хватает, если пишешь письма и переводишь текст.
- **Платный.** Нужен, когда просишь разбирать таблицы каждый день.

Нюанс: цену считают за месяц, а не за год, и это меняет выбор.

Итог простой: начни с бесплатного и посмотри, чего не хватает.`;
    expect(codes(lintPost(tooFew, ctx({ layout: 'b' }))).errors).toContain('layout_bullets_count');
  });

  it('В требует нумерованные шаги и один блок с готовой фразой', () => {
    const body = `# Заголовок обещает результат читателю

Зачем это нужно: чтобы получить готовый текст за минуту, а не за час.

1. Открой чат и начни новый разговор.
2. Вставь фразу ниже и допиши свою задачу.

Что получится: помощник вернёт готовый вариант, который можно править.

Где споткнёшься: если задача размытая, ответ тоже будет размытым.`;
    expect(codes(lintPost(body, ctx({ layout: 'v' }))).errors).toContain('layout_code_required');
  });

  it('Г требует таблицу', () => {
    const body = `# Заголовок отвечает на вопрос, что выбрать

Лид про задачу читателя: нужно выбрать между двумя сервисами и не переплатить.

Кому что: если пишешь тексты каждый день, бери первый. Остальным хватит второго.

Нюанс: у второго нет русского интерфейса, и это заметно в первый же день.`;
    expect(codes(lintPost(body, ctx({ layout: 'g' }))).errors).toContain('layout_table_required');
  });
});

describe('длина', () => {
  it('слишком короткий пост для раскладки — ошибка', () => {
    const body = '# Заголовок утверждает факт\n\nКороткий лид и всё.';
    expect(codes(lintPost(body, ctx({ layout: 'a' }))).errors).toContain('length_short');
  });

  it('длина считается по ВИДИМОМУ тексту, без разметки', () => {
    // Иначе адрес ссылки и теги идут в зачёт длины.
    const padded = `${GOOD_A}\n\n[Ссылка с очень длинным адресом](https://example.com/${'x'.repeat(400)})`;
    expect(codes(lintPost(padded, ctx())).errors).not.toContain('length_long');
  });
});

describe('стена текста', () => {
  it('абзац длиннее потолка — ошибка', () => {
    const long = 'Очень длинное предложение про то, как это работает. '.repeat(8);
    const body = `# Заголовок утверждает факт для читателя\n\n${long}`;
    expect(codes(lintPost(body, ctx())).errors).toContain('paragraph_long');
  });

  it('три абзаца подряд на 724 знака — ошибка (живой пост 11.09)', () => {
    // Telegram рисует абзацы вплотную: читатель видит кирпич.
    const p = (n: number): string =>
      `Абзац номер ${n} про то, как это выглядит на телефоне и почему это важно ` +
      'читателю, который открыл канал в метро и листает одной рукой между станциями, ' +
      'пока поезд идёт от одной пересадки до другой в утренний час пик.';
    const body = `# Заголовок утверждает факт для читателя\n\n${p(1)}\n\n${p(2)}\n\n${p(3)}`;
    const result = lintPost(body, ctx({ layout: 'b' }));
    expect(codes(result).errors).toContain('wall');
    // Сообщение называет и число абзацев, и знаки: по нему автор правит текст.
    expect(formatLint(result)).toMatch(/стена текста: 3 абзаца подряд на \d+ знаков/);
  });

  it('структурный блок разрывает серию и стены нет', () => {
    const p = (n: number): string =>
      `Абзац номер ${n} про то, как это выглядит на телефоне и почему это важно ` +
      'читателю, который открыл канал в метро и листает одной рукой между станциями, ' +
      'пока поезд идёт от одной пересадки до другой в утренний час пик.';
    const body = `# Заголовок утверждает факт для читателя\n\n${p(1)}\n\n## Как это включить\n\n${p(2)}\n\n${p(3)}`;
    expect(codes(lintPost(body, ctx({ layout: 'b' }))).errors).not.toContain('wall');
  });
});

describe('числа', () => {
  it('больше трёх чисел в абзаце — ошибка', () => {
    const body = `# Заголовок утверждает факт для читателя

Тариф стоит 20 долларов, лимит 500 запросов, скидка 15 процентов, срок 30 дней.

Что делать: посчитай, сколько тебе нужно, и выбери подходящий вариант.`;
    expect(codes(lintPost(body, ctx())).errors).toContain('numbers_per_paragraph');
  });

  it('числительные СЛОВАМИ тоже считаются (обход 07.09)', () => {
    const body = `# Заголовок утверждает факт для читателя

Пятьсот аккаунтов, три миллиона запросов, двадцать серверов и сорок часов работы.

Что делать: проверить, попадает ли твой случай в этот список, и не переплачивать
за то, чем не пользуешься каждый день. Проверка занимает пару минут в настройках.

Оговорка (и это важно): в блоге не сказано, работает ли это из России сегодня.`;
    // Правило ловится и на коротком посте: длина тут ни при чём.
    expect(codes(lintPost(body, ctx())).errors).toContain('numbers_per_paragraph');
  });

  it('числа в таблице потолок не нарушают', () => {
    // Таблица и существует ради того, чтобы собрать числа в читаемый блок.
    const body = `# Заголовок отвечает на вопрос, что выбрать

Лид про задачу читателя: нужно выбрать между двумя сервисами и не переплатить.

| Сервис | Цена | Лимит |
|---|---|---|
| Первый | 20 | 500 |
| Второй | 10 | 100 |

Кому что: если пишешь каждый день, бери первый. Остальным хватит второго.`;
    expect(codes(lintPost(body, ctx({ layout: 'g' }))).errors).not.toContain('numbers_per_paragraph');
  });
});

describe('реклама', () => {
  it('cta none и упоминание бренда — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Через Оплатишку это тоже можно. Оговорка:');
    expect(codes(lintPost(body, ctx({ cta: 'none' }))).errors).toContain('cta_none_has_brand');
  });

  it('cta hard без призыва — ошибка', () => {
    expect(codes(lintPost(GOOD_A, ctx({ cta: 'hard' }))).errors).toContain('cta_hard_missing');
  });

  it('cta hard с призывом в конце проходит', () => {
    const body = `${GOOD_A}\n\nПодписку на такой сервис оплатим рублями: @oplatishkaa_bot`;
    const errors = codes(lintPost(body, ctx({ cta: 'hard' }))).errors;
    expect(errors).not.toContain('cta_hard_missing');
  });

  it('cta soft без упоминаний — предупреждение', () => {
    const result = lintPost(GOOD_A, ctx({ cta: 'soft' }));
    expect(codes(result).warnings).toContain('cta_soft_empty');
    expect(codes(result).errors).not.toContain('cta_soft_empty');
  });
});

describe('красные линии', () => {
  it('страна выпуска карты рядом со словом «карта» — ошибка', () => {
    const body = `# Заголовок утверждает факт для читателя

Оплатить можно американской картой, которую выпускают за пару минут онлайн.

Что делать: проверить, принимает ли сервис такой способ оплаты.`;
    expect(codes(lintPost(body, ctx())).errors).toContain('red_line_country');
  });

  it('страна далеко от слова «карта» правило не трогает', () => {
    const body = `# Заголовок утверждает факт для читателя

Сервис работает в США, и это заметно по ценам в его тарифах на подписку.

Оплата проходит обычной картой, выпуск занимает пару минут в приложении банка.

Что делать: посмотреть тариф и решить, нужен ли он тебе сейчас.`;
    expect(codes(lintPost(body, ctx())).errors).not.toContain('red_line_country');
  });

  it('название платёжного провайдера — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Оплату принимает Freekassa. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('red_line_provider');
  });

  it('похожее на номер карты — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Номер 4111 1111 1111 1111 нужен для оплаты. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('red_line_pan');
  });

  it('«сбой» в ЧУЖОЙ новости — предупреждение, а не ошибка (07.09)', () => {
    // Сплошной запрет заставлял автора переписывать факт из источника.
    const body = `# Заголовок утверждает факт для читателя

У сервиса случился сбой, и он не отвечал несколько часов в пятницу вечером.

Что делать: если пользуешься им для работы, держи запасной вариант.`;
    const result = lintPost(body, ctx());
    expect(codes(result).errors).not.toContain('red_line_incident');
    expect(codes(result).warnings).toContain('incident_foreign');
  });

  it('«сбой» рядом с брендом — ошибка', () => {
    const body = `# Заголовок утверждает факт для читателя

У Оплатишки случился сбой, и оплата не проходила несколько часов в пятницу.

Что делать: попробовать позже или написать в поддержку за помощью.`;
    expect(codes(lintPost(body, ctx({ cta: 'soft' }))).errors).toContain('red_line_incident');
  });

  it('гарантия возврата — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Мы гарантируем возврат денег. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('red_line_guarantee');
  });
});

describe('стиль', () => {
  it('длинное тире — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Это важно — и вот почему. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('em_dash');
  });

  it('маркер выделения — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Это ==важно==. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('marker_highlight');
  });

  it('«не просто X, а Y» — ошибка', () => {
    const body = GOOD_A.replace(
      'Оговорка:',
      'Это не просто память, а настоящий помощник. Оговорка:',
    );
    expect(codes(lintPost(body, ctx())).errors).toContain('ai_phrase_not_just');
  });

  it('«прорыв» и «в эпоху» — ошибки', () => {
    const body = GOOD_A.replace(
      'Оговорка:',
      'Это прорыв в эпоху умных помощников. Оговорка:',
    );
    const errors = codes(lintPost(body, ctx())).errors;
    expect(errors).toContain('ai_phrase_breakthrough');
    expect(errors).toContain('ai_phrase_era');
  });

  it('жаргон — предупреждение', () => {
    const body = GOOD_A.replace('Оговорка:', 'Контекстное окно выросло. Оговорка:');
    const result = lintPost(body, ctx());
    expect(codes(result).warnings).toContain('jargon');
    expect(codes(result).errors).not.toContain('jargon');
  });

  it('вывод «ничего не меняется» — предупреждение', () => {
    const body = GOOD_A.replace('Оговорка:', 'Для тебя пока ничего не меняется. Оговорка:');
    expect(codes(lintPost(body, ctx())).warnings).toContain('so_what');
  });

  it('текст без живой связки — предупреждение', () => {
    const body = `# Компания выпустила обновление своего помощника

Обновление доступно всем аккаунтам. Функция включена по умолчанию во всех
регионах. Интерфейс не изменился. Настройки остались на прежнем месте.

Обновление устанавливается автоматически. Дополнительных действий не требуется.`;
    expect(codes(lintPost(body, ctx())).warnings).toContain('voice_flat');
  });

  it('больше трёх эмодзи — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', 'Ура 🎉🎉🎉🎉. Оговорка:');
    expect(codes(lintPost(body, ctx())).errors).toContain('emoji_max');
  });
});

describe('особые блоки и таблица', () => {
  it('два особых блока — ошибка', () => {
    const body = `# Заголовок отвечает на вопрос, что выбрать

Лид про задачу читателя: нужно выбрать между двумя сервисами и не переплатить.

| Сервис | Цена |
|---|---|
| Первый | 20 |

<aside>Главная мысль поста одной фразой для читателя</aside>

Кому что: если пишешь каждый день, бери первый. Остальным хватит второго.`;
    expect(codes(lintPost(body, ctx({ layout: 'g' }))).errors).toContain('special_blocks');
  });

  it('таблица 4 на 6 — ошибка по колонкам и по строкам', () => {
    const body = `# Заголовок отвечает на вопрос, что выбрать

Лид про задачу читателя: нужно выбрать между сервисами и не переплатить лишнего.

| Сервис | Цена | Лимит | Язык |
|---|---|---|---|
| Первый | 20 | 500 | да |
| Второй | 10 | 100 | нет |
| Третий | 30 | 900 | да |
| Четвёртый | 5 | 50 | нет |
| Пятый | 15 | 300 | да |

Кому что: если пишешь каждый день, бери первый. Остальным хватит второго.`;
    const errors = codes(lintPost(body, ctx({ layout: 'g' }))).errors;
    expect(errors).toContain('table_cols');
    expect(errors).toContain('table_rows');
  });

  it('маркер картинки дважды — ошибка', () => {
    const body = GOOD_A.replace('Оговорка:', '[[IMAGE]]\n\nОговорка:') + '\n\n[[IMAGE]]';
    expect(codes(lintPost(body, ctx())).errors).toContain('image_marker');
  });

  it('маркер картинки без файла — ошибка', () => {
    const body = `${GOOD_A}\n\n[[IMAGE]]`;
    expect(codes(lintPost(body, ctx({ hasImage: false }))).errors).toContain(
      'image_marker_without_file',
    );
  });
});

describe('свежесть', () => {
  const previous: PreviousPost[] = [
    {
      id: 'post-1',
      body: `# Google раздала память Gemini бесплатным пользователям

Если коротко, помощник теперь помнит прошлые разговоры и не просит пересказывать.

Проверить можно за минуту в приложении на телефоне.`,
    },
  ];

  it('заголовок с тем же зачином, что у прошлого поста, — ошибка (образец из скилла)', () => {
    const result = lintPost(GOOD_A, ctx({ previous }));
    expect(codes(result).errors).toContain('freshness_opener');
  });

  it('связка из списка стоп-фраз, уже бывшая в прошлом посте, — ошибка', () => {
    const body = `# Новая модель научилась считать таблицы без ошибок

Если коротко, теперь она не путает столбцы и не выдумывает суммы в отчётах.

Что делать: прогони свой файл и сверь пару строк руками.`;
    expect(codes(lintPost(body, ctx({ previous }))).errors).toContain('freshness_phrase');
  });

  it('предложение дословно из прошлого поста — ошибка', () => {
    const body = `# Новая модель научилась считать таблицы без ошибок

Проверить можно за минуту в приложении на телефоне.

Что делать: прогони свой файл и сверь пару строк руками, чтобы не удивляться.`;
    expect(codes(lintPost(body, ctx({ previous }))).errors).toContain('freshness_sentence');
  });

  it('без истории правило молчит', () => {
    expect(codes(lintPost(GOOD_A, ctx({ previous: [] }))).errors).toEqual([]);
  });

  it('одна и та же связка в двух прошлых постах печатается один раз', () => {
    const twice: PreviousPost[] = [previous[0]!, { id: 'post-2', body: previous[0]!.body }];
    const body = `# Новая модель научилась считать таблицы без ошибок

Если коротко, теперь она не путает столбцы и не выдумывает суммы в отчётах.

Что делать: прогони свой файл и сверь пару строк руками.`;
    const phrases = codes(lintPost(body, ctx({ previous: twice }))).errors.filter(
      (code) => code === 'freshness_phrase',
    );
    expect(phrases).toHaveLength(1);
  });

  it('четвёртый пост подряд той же формы — предупреждение', () => {
    const shaped = `# Разбор нового тарифа показывает простую вещь

Лид про задачу читателя и что изменилось за неделю в тарифах сервиса.

## Сколько стоит

- **Базовый.** Хватает для писем.
- **Платный.** Нужен для таблиц.
- **Командный.** Нужен, если вас больше трёх.

Нюанс: считают за месяц.

Итог: начни с бесплатного.`;
    const history: PreviousPost[] = [
      { id: 'p1', body: shaped },
      { id: 'p2', body: shaped.replace('нового тарифа', 'старого тарифа') },
      { id: 'p3', body: shaped.replace('нового тарифа', 'другого тарифа') },
    ];
    const body = shaped.replace(
      '# Разбор нового тарифа показывает простую вещь',
      '# Сервис пересчитал лимиты в своих тарифах',
    );
    expect(codes(lintPost(body, ctx({ layout: 'b', previous: history }))).warnings).toContain(
      'freshness_shape',
    );
  });
});

describe('отчёт', () => {
  it('в одном формате: ОШИБКА и ВНИМАНИЕ', () => {
    const body = GOOD_A.replace('Оговорка:', 'Это прорыв. Контекстное окно выросло. Оговорка:');
    const report = formatLint(lintPost(body, ctx()));
    expect(report).toMatch(/^ОШИБКА: /m);
    expect(report).toMatch(/^ВНИМАНИЕ: /m);
  });

  it('пустой результат даёт пустой отчёт', () => {
    expect(formatLint(lintPost(GOOD_A, ctx()))).toBe('');
  });

  it('пустой текст — ошибка «пустой текст»', () => {
    expect(codes(lintPost('   ', ctx())).errors).toEqual(['empty']);
  });
});
