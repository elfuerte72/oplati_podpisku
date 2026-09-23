/**
 * Версионируемый конфиг бота: рубрики, раскладки, пороги линта, политика рекламы,
 * критерии судьи, лимиты площадок, тарифы модели. Секретов здесь нет — они в env.
 *
 * Правило: числа и правила живут ЗДЕСЬ и в коде, который их читает, а не в
 * промптах и не в текстах. Промпт просит, код проверяет.
 */

export const RUBRIC_KEYS = ['news', 'howto', 'price', 'plain', 'choice'] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];

export const LAYOUT_KEYS = ['a', 'b', 'v', 'g'] as const;
export type LayoutKey = (typeof LAYOUT_KEYS)[number];

export const CTA_LEVELS = ['none', 'soft', 'hard'] as const;
export type CtaLevel = (typeof CTA_LEVELS)[number];

export type PostFormat = 'rich' | 'classic';

export const MODEL_ROLES = [
  'dossier',
  'plan',
  'write',
  'revise',
  'judge',
  'rank',
  'threads',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Требования раскладки к структуре тела. Их форсит линт, а не просьба в промпте. */
export interface LayoutStructure {
  readonly h2: 'forbidden' | 'required-one' | 'optional';
  readonly bullets: 'forbidden' | 'optional' | { readonly min: number; readonly max: number };
  readonly orderedSteps: 'forbidden' | 'optional' | 'required';
  readonly codeBlock: 'forbidden' | 'optional' | 'required-one';
  readonly table: 'forbidden' | 'optional' | 'required-one';
}

export interface Layout {
  readonly key: LayoutKey;
  /** Буква раскладки, как её называет владелец и скилл telegram-copy. */
  readonly letter: string;
  readonly title: string;
  readonly minChars: number;
  readonly maxChars: number;
  readonly format: PostFormat;
  /** Скелет для промпта автора: по строке на шаг. */
  readonly skeleton: readonly string[];
  readonly structure: LayoutStructure;
}

export interface Rubric {
  readonly key: RubricKey;
  readonly title: string;
  readonly share: number;
  readonly layout: LayoutKey;
  /** Уровень рекламы по умолчанию (CTA_BY_RUBRIC прежнего контура). */
  readonly cta: CtaLevel;
  /** Что внутри рубрики — идёт в промпт плана и автора. */
  readonly inside: string;
}

export interface JudgeCriterion {
  readonly key: string;
  readonly description: string;
}

export interface ModelTariff {
  readonly inputPerMillion: number;
  readonly cacheHitPerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelPrice extends ModelTariff {
  readonly isPeak: boolean;
  /** false — тариф неизвестен, счёт считается по тарифу по умолчанию (оценка). */
  readonly known: boolean;
}

export interface RoleConfig {
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /** Из какой env-переменной брать имя модели. */
  readonly model: 'writer' | 'judge' | 'rank';
}

const LAYOUTS: Record<LayoutKey, Layout> = {
  a: {
    key: 'a',
    letter: 'А',
    title: 'Короткая новость',
    minChars: 400,
    maxChars: 700,
    // Новость обязана читаться везде, включая Telegram Web и витрину t.me/s,
    // которые rich-сообщения не рендерят вовсе (ресерч 22.09).
    format: 'classic',
    skeleton: [
      '# Заголовок: целое утверждение с подлежащим и сказуемым',
      'Лид: боль читателя и что изменилось',
      'Один абзац «что тебе делать»',
      'Нюанс одной строкой',
    ],
    structure: {
      h2: 'forbidden',
      bullets: 'forbidden',
      orderedSteps: 'forbidden',
      codeBlock: 'forbidden',
      table: 'forbidden',
    },
  },
  b: {
    key: 'b',
    letter: 'Б',
    title: 'Разбор',
    minChars: 700,
    maxChars: 1500,
    format: 'rich',
    skeleton: [
      '# Заголовок',
      'Лид',
      '## Подзаголовок («Как включить», «Сколько стоит», «Что это даёт»)',
      'Три пункта вида «- **Начало.** пояснение», каждый в одну строку',
      'Абзац с нюансом',
      'Финал: вывод или приглашение',
    ],
    structure: {
      h2: 'required-one',
      bullets: { min: 3, max: 5 },
      orderedSteps: 'optional',
      codeBlock: 'optional',
      table: 'forbidden',
    },
  },
  v: {
    key: 'v',
    letter: 'В',
    title: 'Инструкция',
    minChars: 500,
    maxChars: 1200,
    format: 'rich',
    skeleton: [
      '# Результат в заголовке',
      'Зачем это читателю',
      'Шаги нумерованным списком',
      'Готовая фраза для чат-бота блоком ``` ```, чтобы её копировали одним касанием',
      'Что получится',
      'Где споткнёшься',
    ],
    structure: {
      h2: 'optional',
      bullets: 'optional',
      orderedSteps: 'required',
      codeBlock: 'required-one',
      table: 'forbidden',
    },
  },
  g: {
    key: 'g',
    letter: 'Г',
    title: 'Сравнение',
    minChars: 600,
    maxChars: 1200,
    format: 'rich',
    skeleton: [
      '# Заголовок с ответом',
      'Лид про задачу читателя',
      'Таблица: до трёх колонок и до пяти строк вместе с шапкой',
      'Абзац «кому что» с позицией: что выбрал бы сам',
      'Нюанс',
    ],
    structure: {
      h2: 'optional',
      bullets: 'optional',
      orderedSteps: 'forbidden',
      codeBlock: 'forbidden',
      table: 'required-one',
    },
  },
};

const RUBRICS: Record<RubricKey, Rubric> = {
  news: {
    key: 'news',
    title: 'Что нового в ИИ',
    share: 0.35,
    layout: 'a',
    // Призыв в новости читается спамом (решение владельца 06.09).
    cta: 'none',
    inside: 'что вышло, что умеет на бытовом примере, что тебе с этим сделать',
  },
  howto: {
    key: 'howto',
    title: 'Как этим пользоваться',
    share: 0.25,
    layout: 'v',
    cta: 'none',
    inside: 'результат в заголовке, готовая фраза, что получится, где споткнёшься',
  },
  price: {
    key: 'price',
    title: 'Сколько стоит и стоит ли',
    share: 0.2,
    layout: 'g',
    // Речь о платных тарифах: одно упоминание, что подписку оплатим рублями.
    cta: 'soft',
    inside: 'цена в валюте сервиса, что даёт платный тариф простыми словами, кому платить, кому нет',
  },
  plain: {
    key: 'plain',
    title: 'Простыми словами',
    share: 0.1,
    layout: 'b',
    cta: 'none',
    inside: 'явление одной фразой, бытовая аналогия, почему это важно тебе',
  },
  choice: {
    key: 'choice',
    title: 'Что выбрать',
    share: 0.1,
    layout: 'g',
    cta: 'soft',
    inside: 'задача, один победитель и почему, когда брать другой',
  },
};

/**
 * Связки и зачины, которые автор повторяет из поста в пост, если его не держать
 * за руку. Список намеренно совпадает с приёмами из telegram-copy: приём хорош
 * один раз, а в пятом посте подряд читатель узнаёт шаблон.
 */
const STOCK_PHRASES = [
  'кому что',
  'кому какое дело',
  'кому зайдёт',
  'кому брать',
  'осторожно с восторгом',
  'если коротко',
  'так вот',
  'спойлер',
  'раньше как было',
  'знакомо?',
  'кажется, это',
  'главное за неделю',
  'лучшее за неделю',
  'оказывается',
  'вот тут и начинается',
  'с попкорном',
  'утреннее-полезное',
  'ночное-полезное',
  'ночное-залипательное',
  'и что тебе с этого',
  'как это выглядит на деле',
  'хочется верить',
  'не значит «не ошибается»',
  'ничего срочного',
] as const;

const JUDGE_CRITERIA_TELEGRAM: readonly JudgeCriterion[] = [
  {
    key: 'so_what',
    description:
      'Читатель с телефоном, который слышал про ChatGPT и документацию не откроет, получает конкретный ответ «и что мне с этого»: что сделать, что выбрать, чего не делать. Вывод «для тебя ничего не меняется» — 2 балла и ниже.',
  },
  {
    key: 'voice',
    description:
      'Звучит как рассказ друга за кофе: «мы» нашли, «ты» попробуй; есть позиция; нет пресс-релиза и пафоса. Приёмы живые, а не механически вставленные.',
  },
  {
    key: 'clarity',
    description:
      'Каждую фразу можно прочитать вслух другу. Нет жаргона (токены, контекстное окно, параметры, бенчмарк, эксплойт, уязвимость, фреймворк). Версии моделей — только когда это сама новость.',
  },
  {
    key: 'headline',
    description:
      'Заголовок — целое утверждение с подлежащим и сказуемым, обещает ровно то, что даёт текст, и держит внимание без кликбейта.',
  },
  {
    key: 'structure',
    description:
      'Форма по размеру содержания: список только там, где есть что перечислять; одна мысль на пост; абзацы в одно-три предложения; финал — вывод, нюанс или приглашение, а не пересказ.',
  },
  {
    key: 'facts',
    description:
      'Каждое число и утверждение конкретно и понятно, откуда оно; нет оценочных ярлыков («прорыв», «революция»), нет тройки прилагательных через запятую. Если дано досье источника — ни одного утверждения, которого в нём нет. Если текста источника нет, ты не можешь знать, выдумано ли число: не называй его выдуманным, только отметь, если число ни к чему не привязано.',
  },
  {
    key: 'texture',
    description:
      'В посте есть живая деталь, а не только пересказ источника своими словами: сцена из жизни читателя, конкретный пример, готовая фраза, узнаваемая мелочь. Проверка: запомнит ли человек хоть одну картинку из текста через час. Пересказ отчёта без единой детали — 2 балла, даже если он точный и гладкий.',
  },
];

/**
 * Критерий канала по ключу. Брать по индексу нельзя: вставка одного критерия в
 * список канала молча подменила бы набор для Threads, а `!` спрятал бы это от
 * `noUncheckedIndexedAccess`.
 */
function channelCriterion(key: string): JudgeCriterion {
  const found = JUDGE_CRITERIA_TELEGRAM.find((c) => c.key === key);
  if (found === undefined) throw new Error(`критерий судьи «${key}» не описан`);
  return found;
}

const JUDGE_CRITERIA_THREADS: readonly JudgeCriterion[] = [
  {
    key: 'hook',
    description:
      'Первая строка останавливает палец в ленте: конкретное утверждение, сцена или вопрос с фактом внутри. Не тема («Про новую модель»), не заголовок пресс-релиза. Лента показывает только первые строки, дальше «ещё».',
  },
  channelCriterion('so_what'),
  {
    key: 'voice',
    description:
      'Звучит как реплика человека в разговоре, а не как пост канала и не как пресс-релиз: «мы» нашли, «ты» попробуй; есть позиция; фразы разной длины.',
  },
  {
    key: 'density',
    description:
      'В 500 знаков влезло главное и ничего лишнего: нет вступления, каждое предложение работает; если есть ответы-продолжения, каждый добавляет новое; пост не обрывается на полуслове ради лимита.',
  },
  channelCriterion('clarity'),
  channelCriterion('facts'),
  channelCriterion('texture'),
  {
    key: 'conversation',
    description:
      'Пост даёт повод ответить: вопрос по делу, спорный тезис, выбор из двух. Не выпрашивает реакции («пишите в комментах», «ставьте лайк», «репост») — это Threads прячет. Пост, который просто сообщает и закрывает тему, — 3 балла.',
  },
];

const JUDGE_RED_LINES =
  'страна выпуска карты; название платёжного провайдера или эмитента карт; реквизиты карт; ' +
  'сбои и инциденты Оплатишки; гарантии и обещания возврата; цены в рублях и курс; выдуманные ' +
  'цифры; отзывы и кейсы клиентов; обновления и кнопки самого продукта Оплатишка (про продукт ' +
  'пишет человек). Уровень рекламы обязан совпадать с cta: none — ни бота, ни бренда; soft — одно ' +
  'упоминание внутри текста без строки-призыва; hard — одна строка призыва в конце.';

/**
 * Тарифы модели для учёта расхода. Цифры — с прайса DeepSeek (снимок 22.09.2026):
 * `deepseek-flash` вне пика $0.15/M вход (cache miss), $0.003/M cache hit,
 * $0.60/M выход; в пик — вдвое. Окна пика заданы тикетом 01 и правятся здесь:
 * учёт не деньги провайдера, а наша оценка, и одна правка меняет её целиком.
 */
const MODEL_TARIFFS: Record<string, ModelTariff> = {
  'deepseek-flash': { inputPerMillion: 0.15, cacheHitPerMillion: 0.003, outputPerMillion: 0.6 },
};

const DEFAULT_TARIFF: ModelTariff = MODEL_TARIFFS['deepseek-flash']!;

const PEAK_WINDOWS_UTC: readonly { readonly fromHour: number; readonly toHour: number }[] = [
  { fromHour: 1, toHour: 4 },
  { fromHour: 6, toHour: 10 },
];

/** Пик только в рабочие дни: 1 — понедельник, 5 — пятница (getUTCDay). */
const PEAK_DAYS_UTC: readonly number[] = [1, 2, 3, 4, 5];

export interface SmmConfig {
  readonly rubrics: Record<RubricKey, Rubric>;
  readonly layouts: Record<LayoutKey, Layout>;
  readonly roles: Record<ModelRole, RoleConfig>;
  readonly lint: {
    readonly visibleTextMax: number;
    readonly paragraphMaxChars: number;
    readonly paragraphWarnChars: number;
    readonly wallMinParagraphs: number;
    readonly wallMaxChars: number;
    readonly numbersPerParagraph: number;
    readonly emojiMax: number;
    readonly tableMaxCols: number;
    readonly tableMaxRows: number;
    readonly specialBlocksMax: number;
    readonly freshnessWindow: number;
    readonly stockPhrases: readonly string[];
  };
  readonly ads: {
    readonly levels: readonly CtaLevel[];
    readonly hardMaxShare: number;
    readonly minHistoryForShare: number;
    readonly noTwoHardInARow: boolean;
  };
  readonly judge: {
    readonly passMean: number;
    readonly minScore: number;
    readonly maxRounds: number;
    readonly telegram: { readonly criteria: readonly JudgeCriterion[]; readonly redLines: string };
    readonly threads: { readonly criteria: readonly JudgeCriterion[]; readonly redLines: string };
  };
  readonly threads: {
    readonly pieceLimit: number;
    readonly emojiWeight: number;
    readonly postTarget: number;
    readonly replyTarget: number;
    readonly maxPieces: number;
    readonly piecesWarn: number;
    readonly emojiMax: number;
    readonly hookMax: number;
    readonly tagMax: number;
    readonly intentBase: string;
    readonly intentUrlMax: number;
    readonly separator: string;
  };
  readonly formats: {
    readonly classic: { readonly captionMax: number; readonly textMax: number };
    readonly rich: {
      readonly charsMax: number;
      readonly blocksMax: number;
      readonly mediaMax: number;
      readonly tableColsMax: number;
    };
  };
  readonly markers: {
    readonly image: string;
    readonly coverId: string;
    readonly coverRef: string;
  };
  readonly buttons: {
    readonly bot: { readonly text: string; readonly url: string };
  };
  readonly sources: {
    readonly telegramChannels: readonly string[];
    readonly rss: readonly string[];
    /** Сколько последних выпусков рассылки Forward Future разбирать; 0 — не опрашиваем. */
    readonly forwardFutureIssues: number;
    readonly xAccounts: readonly string[];
    readonly subreddits: readonly string[];
    readonly threadsQueries: readonly string[];
    readonly pollWindowMsk: { readonly fromHour: number; readonly toHour: number };
    readonly pollEveryHours: number;
    readonly cacheHours: number;
    readonly digestTopN: number;
    readonly digestWindowHours: number;
  };
  readonly http: {
    readonly userAgent: string;
    readonly articleTimeoutMs: number;
    readonly articleMaxBytes: number;
    readonly imageMaxBytes: number;
  };
  readonly flow: {
    /** Сколько живёт вопрос бота. Истёкшее ожидание — не «бот ждал неделю», а idle. */
    readonly questionTtlMs: number;
  };
  /**
   * Файлы системных промптов ролей в `src/llm/prompts`. В коде — только имена:
   * правки формулировок не задевают логику, а логика не переписывает промпты.
   */
  readonly prompts: Record<ModelRole, string>;
}

export const smmConfig: SmmConfig = {
  rubrics: RUBRICS,
  layouts: LAYOUTS,
  roles: {
    // Сроки разные по делу: автор и правки отдают длинный текст не потоком, а
    // разбор источника и ранжирование — короткий JSON. Один срок на всех
    // означал бы, что зависший короткий шаг держит владельца две минуты.
    dossier: { temperature: 0, maxTokens: 4000, timeoutMs: 90_000, model: 'writer' },
    plan: { temperature: 0.3, maxTokens: 2000, timeoutMs: 60_000, model: 'writer' },
    write: { temperature: 0.7, maxTokens: 4000, timeoutMs: 120_000, model: 'writer' },
    revise: { temperature: 0.3, maxTokens: 4000, timeoutMs: 120_000, model: 'writer' },
    judge: { temperature: 0, maxTokens: 2000, timeoutMs: 120_000, model: 'judge' },
    rank: { temperature: 0, maxTokens: 4000, timeoutMs: 90_000, model: 'rank' },
    threads: { temperature: 0.5, maxTokens: 2000, timeoutMs: 90_000, model: 'writer' },
  },
  lint: {
    // Потолок видимого текста ниже лимита Telegram: остаток съедают футер и разметка.
    visibleTextMax: 4000,
    paragraphMaxChars: 350,
    paragraphWarnChars: 280,
    wallMinParagraphs: 3,
    wallMaxChars: 600,
    numbersPerParagraph: 3,
    emojiMax: 3,
    tableMaxCols: 3,
    tableMaxRows: 5,
    specialBlocksMax: 1,
    freshnessWindow: 5,
    stockPhrases: STOCK_PHRASES,
  },
  ads: {
    levels: CTA_LEVELS,
    hardMaxShare: 0.4,
    // Доля считается от пяти постов: на одном-двух любой процент врёт.
    minHistoryForShare: 5,
    noTwoHardInARow: true,
  },
  judge: {
    passMean: 4,
    minScore: 3,
    maxRounds: 2,
    telegram: { criteria: JUDGE_CRITERIA_TELEGRAM, redLines: JUDGE_RED_LINES },
    threads: {
      criteria: JUDGE_CRITERIA_THREADS,
      redLines:
        JUDGE_RED_LINES +
        ' Разметка markdown (звёздочки, решётки, обратные апострофы, таблицы): Threads покажет её ' +
        'буквально. Ссылка в первом посте, а не в последнем ответе. Просьбы о лайках, репостах и ' +
        'комментариях.',
    },
  },
  threads: {
    // Лимит площадки 500, но эмодзи там считаются байтами UTF-8: потолок 480 —
    // запас на это расхождение, иначе композер покажет красный счётчик.
    pieceLimit: 480,
    emojiWeight: 4,
    postTarget: 300,
    replyTarget: 400,
    maxPieces: 5,
    piecesWarn: 3,
    emojiMax: 3,
    hookMax: 120,
    tagMax: 50,
    intentBase: 'https://www.threads.com/intent/post',
    // Кириллица в percent-encoding — шесть знаков на букву, поэтому потолок адреса низкий.
    intentUrlMax: 4000,
    separator: '---',
  },
  formats: {
    classic: { captionMax: 1024, textMax: 4096 },
    rich: { charsMax: 32_768, blocksMax: 500, mediaMax: 50, tableColsMax: 20 },
  },
  markers: {
    image: '[[IMAGE]]',
    coverId: 'cover',
    coverRef: '![](tg://photo?id=cover)',
  },
  buttons: {
    bot: { text: 'Оплатить подписку', url: 'https://t.me/oplatishkaa_bot?start=channel' },
  },
  sources: {
    // ⚠️ Пустой список означает «источник не опрашиваем». Ленты ниже проверены
    // живым запросом 22.09.2026; каналы, аккаунты X, сабреддиты и запросы
    // Threads — редакторский выбор владельца, и до его слова они пусты:
    // выдуманный канал в конфиге выглядит как рабочий источник, а отдаёт
    // только строку «опрос не удался» каждые два часа.
    // Каналы выбрал владелец 23.09.2026; витрины проверены живым разбором в тот
    // же день (8 и 9 материалов со ссылкой на первоисточник за двое суток).
    // Половина тем у обоих — для разработчиков: их отсеивает ранжирование.
    telegramChannels: ['data_secrets', 'xor_journal'],
    rss: [
      'https://openai.com/news/rss.xml',
      'https://blog.google/technology/ai/rss/',
      'https://huggingface.co/blog/feed.xml',
    ],
    // Рассылка выходит по будням; два выпуска закрывают понедельник после
    // выходных и опрос, случившийся до утреннего выпуска.
    forwardFutureIssues: 2,
    xAccounts: [],
    subreddits: [],
    threadsQueries: [],
    pollWindowMsk: { fromHour: 9, toHour: 22 },
    pollEveryHours: 2,
    cacheHours: 12,
    digestTopN: 10,
    digestWindowHours: 48,
  },
  http: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) oplatishka-smm/1.0',
    articleTimeoutMs: 20_000,
    articleMaxBytes: 200 * 1024,
    imageMaxBytes: 10 * 1024 * 1024,
  },
  flow: {
    questionTtlMs: 24 * 60 * 60 * 1000,
  },
  prompts: {
    dossier: 'dossier.md',
    plan: 'plan.md',
    write: 'write.md',
    revise: 'revise.md',
    judge: 'judge.md',
    rank: 'rank.md',
    threads: 'threads.md',
  },
};

/** Раскладка ли это. Значение приходит из БД строкой, и мусор там возможен. */
export function isLayoutKey(value: unknown): value is LayoutKey {
  return typeof value === 'string' && (LAYOUT_KEYS as readonly string[]).includes(value);
}

export function layoutFor(rubric: RubricKey): Layout {
  return smmConfig.layouts[smmConfig.rubrics[rubric].layout];
}

export function isPeakAt(at: Date): boolean {
  if (!PEAK_DAYS_UTC.includes(at.getUTCDay())) return false;
  const hour = at.getUTCHours();
  return PEAK_WINDOWS_UTC.some((w) => hour >= w.fromHour && hour < w.toHour);
}

/** Тариф модели на момент запроса. Неизвестная модель считается по тарифу по умолчанию. */
export function modelPriceUsd(model: string, at: Date): ModelPrice {
  const known = Object.hasOwn(MODEL_TARIFFS, model);
  const tariff = MODEL_TARIFFS[model] ?? DEFAULT_TARIFF;
  const peak = isPeakAt(at);
  const k = peak ? 2 : 1;
  return {
    inputPerMillion: tariff.inputPerMillion * k,
    cacheHitPerMillion: tariff.cacheHitPerMillion * k,
    outputPerMillion: tariff.outputPerMillion * k,
    isPeak: peak,
    known,
  };
}

/** Рубрика по названию, которое видит владелец (кнопки отдают title, а не ключ). */
export function rubricByTitle(title: string): Rubric | undefined {
  return RUBRIC_KEYS.map((key) => RUBRICS[key]).find((r) => r.title === title);
}
