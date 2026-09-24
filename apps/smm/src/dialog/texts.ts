import { PICK_LIMITS, type AngleOption, type SourceCandidate } from './types.ts';

/** Длинный вариант обрезается в тексте тоже: сообщение читают с телефона. */
const OPTION_MAX_CHARS = 200;

/**
 * Вопрос с вариантами: ПОЛНЫЙ текст — в сообщении, номер — в кнопке. В кнопку
 * Telegram на телефоне влезает треть заголовка, и владелец выбирал бы по
 * обрывку (жалоба 24.09.2026).
 */
function numbered(question: string, options: readonly string[]): string {
  const lines = options.map((option, index) => {
    const clean = option.replace(/\s+/g, ' ').trim();
    const short = clean.length > OPTION_MAX_CHARS ? `${clean.slice(0, OPTION_MAX_CHARS - 1)}…` : clean;
    return `${index + 1}. ${short}`;
  });
  return [question, '', ...lines].join('\n');
}

/** Сайт первоисточника: по нему видно, чья это статья, ещё до перехода. */
function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, '') : '';
}

/**
 * Тексты вопросов и подписи кнопок — ОДИН словарь.
 *
 * Тон безличный и короткий: это рабочий инструмент владельца, а не собеседник.
 * Голос канала живёт в постах, а не в служебных строках.
 */

export const TEXTS = {
  menu: [
    'Команды:',
    '/post <ссылка или тема> — новый пост в канал',
    '/threads <ссылка или тема> — пост для Threads',
    '/ideas — темы из источников',
    '/queue — черновики',
    '/stats — статистика и расход',
    '/settings — настройки',
  ].join('\n'),
  askSource: 'Пришли ссылку на статью или тему словами.',
  askSourcePick: (candidates: readonly SourceCandidate[]): string =>
    numbered(
      'Выбери первоисточник — номер кнопкой:',
      candidates.slice(0, PICK_LIMITS.sources).map((candidate) => {
        const host = hostOf(candidate.url);
        return host === '' ? candidate.title : `${candidate.title} (${host})`;
      }),
    ),
  askRubric: 'Рубрика:',
  askAngle: (angles: readonly AngleOption[]): string =>
    numbered(
      'Угол — номер кнопкой:',
      angles
        .slice(0, PICK_LIMITS.angles)
        .map((angle) => (angle.idea.trim() === '' ? angle.title : `${angle.title} — ${angle.idea}`)),
    ),
  working: 'Собираю. Это займёт до минуты.',
  stillWorking: 'Ещё собираю, подожди.',
  previewReady: 'Так пост уйдёт в канал.',
  /**
   * Подпись под превью, когда каналов несколько. Превью нарисовано для
   * основного канала: во втором под постом нет кнопки бота, и это сказано
   * прямо, а не оставлено догадке.
   */
  noBotButton: (titles: readonly string[]): string =>
    `${titles.join(', ')}: без кнопки «Оплатить подписку» под постом.`,
  /** Почему кнопки канала нет под превью. */
  channelRefused: (title: string, reason: string): string => `${title}: не публикую — ${reason}.`,
  autoDraftFailed: (platform: 'telegram' | 'threads', slot: string, reason: string): string =>
    `Черновик ${platform === 'threads' ? 'для Threads ' : ''}на ${slot}: ${reason}`,
  autoDraftPaused: (platform: 'telegram' | 'threads', max: number): string =>
    `Черновики ${platform === 'threads' ? 'для Threads ' : ''}по расписанию на паузе: ждут решения ${max}. ` +
    'Разбери их в /queue — и расписание продолжится.',
  autoDraftReady: (platform: 'telegram' | 'threads', slot: string): string =>
    platform === 'threads'
      ? `Черновик для Threads на ${slot} по расписанию — выше.`
      : `Черновик на ${slot} по расписанию. Так пост уйдёт в канал.`,
  askEditChoice: 'Что делаем?',
  askEditText: 'Скажи, что поменять.',
  askOwnerText: 'Пришли свой текст: уйдёт дословно, редактор его не смотрит.',
  dropped: 'Снял.',
  ideaSkipped: 'Пропустил.',
  ideaOfftopic: 'Запомнил: такое больше не предлагаю.',
  published: 'Опубликовал.',
  threadsReady: 'Пост для Threads готов. Выложи кнопкой и отметь «Выложил».',
  threadsPosted: 'Отметил как выложенный.',
  cancelled: 'Отменил.',
  stale: 'Кнопка устарела.',
  notNow: 'Сейчас другой шаг.',
  expired: 'Прошлый вопрос истёк. Начни заново: /post',
  nothingChanges: (note: string): string =>
    `Для читателя тут ничего не меняется: ${note}\nПредложи другую тему или пришли другую ссылку.`,
  publishPending: (seconds: number): string => `Выйдет через ${seconds} с.`,
  // Что делают кнопки, сказано прямо под ними: «Показать как есть» без
  // пояснения читалась загадкой (вопрос владельца 24.09.2026).
  failed: (summary: string): string =>
    [
      'Пост не прошёл проверку.',
      summary,
      '',
      '«Показать как есть» — посмотреть текст и решить самому: опубликовать, поправить или взять другой угол.',
      '«Снять» — выбросить черновик.',
    ]
      .filter((line, index) => index !== 1 || line !== '')
      .join('\n'),
  stepFailed: (reason: string): string => `Шаг не прошёл: ${reason}`,
  buttons: {
    publish: 'Опубликовать',
    publishBoth: 'В оба канала',
    edit: 'Правки',
    otherAngle: 'Другой угол',
    drop: 'Снять',
    cancel: 'Отменить',
    back: 'Назад',
    sayWhat: 'Скажу, что поменять',
    ownText: 'Пришлю свой текст',
    showAsIs: 'Показать как есть',
    moreAngles: 'Другие углы',
    skip: 'Пропустить',
    writeIt: 'Написать',
    offtopic: 'Не по теме',
    posted: 'Выложил',
    openThreads: 'Открыть в Threads',
    copyText: 'Скопировать текст',
    threadsVersion: 'Версия для Threads',
  },
} as const;

export type Texts = typeof TEXTS;
