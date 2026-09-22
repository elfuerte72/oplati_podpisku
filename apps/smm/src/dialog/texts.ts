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
  askSourcePick: 'Выбери первоисточник:',
  askRubric: 'Рубрика:',
  askAngle: 'Угол:',
  working: 'Собираю. Это займёт до минуты.',
  stillWorking: 'Ещё собираю, подожди.',
  previewReady: 'Так пост уйдёт в канал.',
  askEditChoice: 'Что делаем?',
  askEditText: 'Скажи, что поменять.',
  askOwnerText: 'Пришли свой текст: уйдёт дословно, редактор его не смотрит.',
  dropped: 'Снял.',
  cancelled: 'Отменил.',
  stale: 'Кнопка устарела.',
  notNow: 'Сейчас другой шаг.',
  expired: 'Прошлый вопрос истёк. Начни заново: /post',
  nothingChanges: (note: string): string =>
    `Для читателя тут ничего не меняется: ${note}\nПредложи другую тему или пришли другую ссылку.`,
  publishPending: (seconds: number): string => `Выйдет через ${seconds} с.`,
  failed: (summary: string): string => `Пост не прошёл проверку.\n${summary}`,
  stepFailed: (reason: string): string => `Шаг не прошёл: ${reason}`,
  buttons: {
    publish: 'Опубликовать',
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
  },
} as const;

export type Texts = typeof TEXTS;
