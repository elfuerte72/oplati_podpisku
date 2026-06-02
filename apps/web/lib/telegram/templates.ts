import 'server-only';

/**
 * Централизованные текстовые шаблоны для Telegram-бота.
 *
 * Хранятся в одном месте, чтобы:
 *   - копирайтер мог менять формулировки без правок логики;
 *   - тексты на медиа/handoff/таймауты выглядели единообразно;
 *   - бизнес-константы (рабочие часы оператора) не размазывались по коду.
 */

export type MediaKind =
  | 'photo'
  | 'voice'
  | 'video_note'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'animation'
  | 'video';

/**
 * Ответы на нетекстовые сообщения. Без эмодзи, в стиле остального промпта.
 * Caption обрабатывается отдельно — как обычный текст в AI-агенте.
 */
export const MEDIA_REPLY: Record<MediaKind, string> = {
  photo:
    'Я не умею читать картинки. Напиши текстом, какую подписку нужно оплатить — название сервиса и, если знаешь, тариф.',
  voice:
    'Голосовые пока не понимаю. Напиши текстом, что нужно — подберу вариант оплаты.',
  audio:
    'Голосовые пока не понимаю. Напиши текстом, что нужно — подберу вариант оплаты.',
  video_note:
    'Не открываю видеосообщения. Если это скрин сервиса — напиши его название текстом.',
  video:
    'Не открываю видео. Если это скрин сервиса — напиши его название текстом.',
  document:
    'Не открываю файлы. Если это скрин сервиса — напиши его название текстом.',
  sticker: 'Не понял. Напиши, какую подписку нужно оплатить.',
  animation: 'Не понял. Напиши, какую подписку нужно оплатить.',
};

/**
 * Рабочие часы оператора в часовом поясе Europe/Moscow.
 * Используются для расчёта SLA-текста в request_human и в системном промпте.
 */
export const OPERATOR_HOURS = {
  fromHour: 10,
  toHour: 22,
  tz: 'Europe/Moscow',
} as const;

/**
 * Текущее время попадает в рабочие часы оператора?
 * `now` — для тестируемости.
 */
export function isWithinOperatorHours(now: Date = new Date()): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATOR_HOURS.tz,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  const hour = Number.parseInt(hourStr, 10);
  if (Number.isNaN(hour)) return true;
  return hour >= OPERATOR_HOURS.fromHour && hour < OPERATOR_HOURS.toHour;
}
