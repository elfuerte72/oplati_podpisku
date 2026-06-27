import 'server-only';

import { formatExpires, formatRub } from '@/components/comic/format';
import type { CatalogService, CatalogTier } from '@/lib/catalog/build';

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
 * Кнопочный каталог в Telegram — зеркало happy-path сайта (сервис → тариф →
 * заказ → оплата), целиком мимо AI. Тексты и форматтеры лейблов кнопок здесь.
 */

/** Подпись inline-кнопки «Выбрать сервис» (под /start, в /menu). */
export const CATALOG_OPEN_BUTTON = 'Выбрать сервис';

/** Заголовок сообщения со списком сервисов. */
export const CATALOG_LIST_PROMPT = 'Что оплатить? Выбери сервис из списка:';

/** Подпись кнопки «Свой вариант» (уводит в чат с агентом). */
export const CATALOG_OWN_VARIANT_BUTTON = 'Свой вариант';

/** Подпись кнопки «Назад» к списку сервисов. */
export const CATALOG_BACK_BUTTON = '<< Назад к списку';

/** Подсказка под кнопкой «Свой вариант». */
export const CATALOG_OWN_VARIANT_TEXT =
  'Напиши, что нужно оплатить — название сервиса и тариф. Найду цену и оформлю заказ.';

/** Каталог не открылся (БД/курс недоступны). */
export const CATALOG_UNAVAILABLE_TEXT =
  'Каталог сейчас не открылся. Попробуй ещё раз через минуту или напиши, что нужно, текстом — оформлю вручную.';

/** Сообщение со списком тарифов сервиса. */
export function catalogTierPrompt(serviceName: string): string {
  return `${serviceName} — выбери тариф:`;
}

/** Лейбл кнопки тарифа: «Plus · месяц — 1 750 ₽». */
export function catalogTierButtonLabel(tier: CatalogTier): string {
  const period =
    tier.period === 'year' ? 'год' : tier.period === 'quarter' ? '3 месяца' : 'месяц';
  return `${tier.name} · ${period} — ${formatRub(tier.totalKopecks)}`;
}

/** Запрос суммы для custom-amount сервиса (Airbnb и т.п.). */
export function catalogCustomAmountPrompt(service: CatalogService): string {
  const kyc = service.requiresKyc
    ? '\n\nМожет понадобиться верификация (KYC) — подскажу при оформлении.'
    : '';
  return (
    `${service.name}: у этого сервиса нет фиксированных тарифов. ` +
    `Напиши сумму к оплате в долларах — число от $1 до $500 (например: 120).${kyc}`
  );
}

/** Сумма не распознана в режиме ожидания ввода. */
export const CATALOG_AMOUNT_INVALID_TEXT =
  'Не понял сумму. Напиши число в долларах от $1 до $500 — например: 120. Или нажми /menu, чтобы выбрать другой сервис.';

/**
 * Ответ на /support — вызов оператора. Пока MOCK: реальный handoff оператору
 * (Telegram forum-topics) ещё не реализован, поэтому отвечаем заглушкой.
 */
export const SUPPORT_MOCK_TEXT =
  'Данная настройка в разработке. Связь с оператором появится здесь чуть позже — а пока просто напиши, что нужно оплатить, и я помогу.';

/** Текст карточки заказа под кнопками «Подтвердить» / «Отменить». */
export function orderCardText(card: {
  shortId: string;
  service: string;
  totalKopecks: number;
  expiresAt: string;
}): string {
  return (
    `Заказ №${card.shortId}\n` +
    `${card.service}\n` +
    `К оплате: ${formatRub(card.totalKopecks)}\n` +
    `Заказ действует до ${formatExpires(card.expiresAt)}.\n\n` +
    'Подтверди оплату кнопкой ниже.'
  );
}

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
