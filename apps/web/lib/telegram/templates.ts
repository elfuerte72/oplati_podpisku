import 'server-only';

import { formatExpires, formatRub } from '@/components/comic/format';
import type { CatalogService, CatalogTier } from '@/lib/catalog/build';

import { MIN_AMOUNT_USD, maxAmountUsdFor } from './amount';

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

// ─── Стартовое меню (/start) ──────────────────────────────────────────────
//
// Inline-меню под приветствием: Mini App (каталог + оплата + карта + партнёрка),
// поддержка и заглушки будущих продуктов (VPN, канал).

/** Подпись web_app-кнопки Mini App (открывает /cabinet). */
export const START_APP_BUTTON = '📱 Открыть приложение';

/** Подпись кнопки поддержки в стартовом меню (callback `support`). */
export const START_SUPPORT_BUTTON = '🛟 Поддержка';

/** Подпись кнопки VPN (продукт в разработке; callback `vpn`). */
export const START_VPN_BUTTON = '🛡 VPN';

/** Подпись кнопки Telegram-канала (канала ещё нет; callback `channel`). */
export const START_CHANNEL_BUTTON = '📣 Telegram-канал';

/** Ответ на кнопку VPN, пока продукт в разработке. */
export const VPN_MOCK_TEXT =
  'VPN Оплатишки пока в разработке — скоро его можно будет подключить прямо здесь, с оплатой в рублях. Как запустим — напишу первым. А подписки можно оплатить уже сейчас: жми «Открыть приложение».';

/** Ответ на кнопку канала, пока канал не создан. */
export const CHANNEL_MOCK_TEXT =
  'Канал вот-вот запустим: новости сервиса, акции и подсказки по оплате зарубежных подписок. Как появится — кнопка станет ссылкой на канал.';

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

/**
 * Совет про НДС/VPN — показываем на ЛЮБОМ сервисе (и тарифы, и custom-amount),
 * чтобы реальный charge не вырос из-за локального налога: подписка $100 из-за
 * локации может списаться как $111. Карта американская, под US VPN — без НДС.
 */
export const VAT_VPN_HINT =
  'Платим американской картой без НДС. На сайте сервиса включи VPN с локацией США — иначе из-за локации спишется больше (например, подписка $100 обойдётся в $111).';

/** Сообщение со списком тарифов сервиса. */
export function catalogTierPrompt(serviceName: string): string {
  return `${serviceName} — выбери тариф:\n\n${VAT_VPN_HINT}`;
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
    `Напиши сумму к оплате в долларах — без НДС, число от $${MIN_AMOUNT_USD} до $${maxAmountUsdFor(service.slug)} (например: 120).\n\n` +
    `${VAT_VPN_HINT}${kyc}`
  );
}

/** Сумма не распознана в режиме ожидания ввода (maxUsd — потолок выбранного сервиса). */
export function catalogAmountInvalidText(maxUsd: number): string {
  return `Не понял сумму. Напиши число в долларах от $${MIN_AMOUNT_USD} до $${maxUsd} — например: 120. Или нажми /menu, чтобы выбрать другой сервис.`;
}

// ─── Поддержка (/support) ─────────────────────────────────────────────────
//
// Interim-handoff: бот пересылает обращение оператору в личку (Telegram ID из
// SUPPORT_OPERATOR_CHAT_ID). Целевая схема — forum-topics — ещё не реализована.

/** Подпись inline-кнопки «Поддержка» (под приветствием /start). */
export const SUPPORT_BUTTON = 'Написать в поддержку';

/** /support без аргументов — просим описать проблему (двухшаговый флоу). */
export const SUPPORT_ASK_TEXT =
  'Опиши, пожалуйста, что случилось — одним сообщением. Если это про конкретный заказ, добавь его номер. Я сразу передам всё оператору, и он свяжется с тобой здесь.';

/** Обращение принято и ушло оператору. */
export const SUPPORT_SENT_TEXT =
  'Готово — передал оператору. Он напишет тебе здесь, в Telegram, в ближайшее время. Обычно отвечаем с 10:00 до 22:00 МСК.';

/** Не удалось доставить обращение оператору. */
export const SUPPORT_FAIL_TEXT =
  'Не получилось передать оператору прямо сейчас — что-то на нашей стороне. Попробуй ещё раз через пару минут.';

/** БД недоступна — двухшаговый флоу невозможен, направляем на inline-форму. */
export const SUPPORT_UNAVAILABLE_TEXT =
  'Чтобы позвать оператора, отправь одним сообщением: /support и описание проблемы. Например: /support не приходит ссылка на оплату.';

/** Жёсткий лимит длины сообщения Telegram (символы). */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Мягкий потолок пользовательского описания в сообщении оператору (символы). */
export const SUPPORT_MESSAGE_MAX_LEN = 3500;

/** HTML-escape пользовательского текста для parse_mode: 'HTML'. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Обрезает УЖЕ экранированный HTML до `max` символов, не разрывая сущность
 * (`&amp;` и т.п.): если хвост оканчивается на «&…» без «;», отступаем до начала
 * сущности — иначе Telegram отвергнет parse_mode HTML (can't parse entities).
 */
function truncateEscapedHtml(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';')) {
    cut = cut.slice(0, lastAmp);
  }
  return `${cut}…`;
}

/**
 * Сообщение оператору об обращении в поддержку (parse_mode HTML). Чистая
 * функция — тестируется без бота. Пользовательские поля экранируются.
 *
 * Обрезка описания идёт ПОСЛЕ экранирования: `escapeHtml` может раздуть символ
 * до 5× (`&` → `&amp;`), поэтому cap по «сырой» длине не гарантировал бы лимит
 * Telegram (находка greptile — «/support» + 3500 «&» давал ~17500 символов и
 * ронял sendMessage). Бюджет тела = остаток до 4096 после шапки (и не больше
 * SUPPORT_MESSAGE_MAX_LEN). `tg://user?id=` — кликабельный переход к клиенту.
 */
export function buildSupportOperatorMessage(params: {
  telegramId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  description: string;
}): string {
  const name = [params.firstName, params.lastName]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ');
  const nameLine = name.length > 0 ? escapeHtml(name) : 'без имени';
  const handleLine = params.username ? `@${escapeHtml(params.username)}` : '—';
  const header =
    '🆘 <b>Новое обращение в поддержку</b>\n\n' +
    `<b>Пользователь:</b> ${nameLine}\n` +
    `<b>Username:</b> ${handleLine}\n` +
    `<b>Telegram ID:</b> <code>${params.telegramId}</code>\n` +
    `<b>Профиль:</b> <a href="tg://user?id=${params.telegramId}">открыть чат</a>\n\n` +
    '<b>Сообщение:</b>\n';
  // -1 — запас под «…», добавляемый при обрезке.
  const bodyBudget = Math.max(
    0,
    Math.min(SUPPORT_MESSAGE_MAX_LEN, TELEGRAM_MESSAGE_LIMIT - header.length - 1),
  );
  return header + truncateEscapedHtml(escapeHtml(params.description), bodyBudget);
}

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
