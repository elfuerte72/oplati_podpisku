import 'server-only';

import { formatExpires, formatRub, formatUsd } from '@/components/comic/format';
import type { CatalogService, CatalogTier } from '@/lib/catalog/build';
import { PAYMENT_ISSUE_LABELS, type PaymentIssueType } from '@/lib/cabinet/payment-issues';
import { buyerFeeAmountNote, buyerFeeNote } from '@/lib/payments/buyer-fee';

import { MIN_AMOUNT_USD, maxAmountUsdFor } from './amount';
import { telegramBotLink } from './links';

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

/** Подпись кнопки VPN (выдача ссылки-подписки Remnawave; callback `vpn`). */
export const START_VPN_BUTTON = '🛡 VPN';

/** Подпись url-кнопки Telegram-канала в стартовом меню. */
export const START_CHANNEL_BUTTON = '📣 Telegram-канал';

/** Публичный Telegram-канал Оплатишки (создан 2026-07-10). */
export const TELEGRAM_CHANNEL_URL = telegramBotLink('ooplatishka');

/** Подпись url-кнопки «Сайт» в стартовом меню (открывает главный сайт Оплатишки). */
export const START_SITE_BUTTON = '🌐 Сайт';

/** Подпись url-кнопки «Как оплатить» в стартовом меню (ведёт на страницу-инструкцию). */
export const START_HOWTO_BUTTON = '📖 Как оплатить';

/** Подпись url-кнопки инструкции под финальным сообщением с реквизитами карты. */
export const CARD_HOWTO_BUTTON = '📖 Как оплатить — пошагово';

/** Подпись url-кнопки официального прайса купленного сервиса. */
export const SERVICE_PRICING_BUTTON = 'Открыть прайс сервиса';

// ─── VPN Оплатишки (Remnawave) ────────────────────────────────────────────
//
// Кнопка «VPN» выдаёт персональную ссылку-подписку: клиент ставит Happ,
// добавляет ссылку как «URL подписки» и получает оба сервера (Литва + «При
// белых списках»). Тексты и клавиатура — здесь, логика — vpn-flow.ts.

/** Официальные сторы приложения Happ (проверены 2026-07-21). */
export const HAPP_APPSTORE_URL =
  'https://apps.apple.com/us/app/happ-proxy-utility/id6504287215';
export const HAPP_GOOGLEPLAY_URL =
  'https://play.google.com/store/apps/details?id=com.happproxy';

/** Подписи url-кнопок сторов под сообщением со ссылкой. */
export const VPN_APPSTORE_BUTTON = '📱 Happ для iPhone';
export const VPN_GOOGLEPLAY_BUTTON = '🤖 Happ для Android';

/** Подпись callback-кнопки перевыпуска ссылки (`vpn:refresh`). */
export const VPN_REFRESH_BUTTON = '🔄 Обновить ссылку';

/** Remnawave не настроен (нет токена) или недоступна БД. */
export const VPN_UNAVAILABLE_TEXT =
  'VPN ненадолго отдыхает: ведём технические работы. Загляни чуть позже!';

/** Ошибка панели/сети при выдаче или обновлении ссылки. */
export const VPN_ERROR_TEXT =
  'Ой, ссылка сейчас не выдалась. Попробуй ещё раз через пару минут, я уже разбираюсь!';

/**
 * «21 августа 2026» (Europe/Moscow). Хвост « г.» из ru-RU-формата убираем:
 * дальше в шаблоне идёт точка предложения, и получалось «2026 г.. Трафик».
 */
function formatVpnExpiry(date: Date): string {
  try {
    return date
      .toLocaleDateString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
      .replace(/\s*г\.\s*$/, '');
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Сообщение со ссылкой-подпиской (parse_mode HTML: ссылка в `<code>`,
 * копируется тапом). Три варианта вступления: `new` (первая выдача),
 * `existing` (повторное нажатие возвращает ту же ссылку), `refreshed`
 * (после «Обновить ссылку»: старая отозвана в панели). Ссылка приходит из
 * панели, но экранируем как любой внешний ввод. `trafficLimitGb` — лимит из
 * env, чтобы текст не разъезжался с реальной настройкой (0 = безлимит).
 */
export function buildVpnMessageHtml(params: {
  kind: 'new' | 'existing' | 'refreshed';
  subscriptionUrl: string;
  expireAt: Date;
  trafficLimitGb: number;
}): string {
  const intro =
    params.kind === 'new'
      ? '🛡 <b>Твой VPN готов!</b>'
      : params.kind === 'refreshed'
        ? '🛡 <b>Ссылка обновлена!</b> Старая больше не работает. В Happ удали прежнюю подписку и добавь новую.'
        : '🛡 <b>Твоя VPN-ссылка уже выпущена, лови её ещё раз.</b> Если она не работает или попала в чужие руки, жми «Обновить ссылку» внизу.';
  const traffic =
    params.trafficLimitGb > 0
      ? `Трафик: ${params.trafficLimitGb} ГБ в месяц, хватит с запасом.`
      : 'Трафик безлимитный.';
  return [
    intro,
    '',
    'Ссылка-подписка, тапни и она скопируется:',
    `<code>${escapeHtml(params.subscriptionUrl)}</code>`,
    '',
    '<b>Как подключить:</b>',
    '1. Скачай приложение Happ, кнопки ниже.',
    '2. В Happ нажми «+» в правом верхнем углу.',
    '3. Выбери «URL подписки».',
    '4. Вставь ссылку и жми «Готово».',
    '',
    'Внутри два сервера: 🇱🇹 Литва и 🇷🇺 «При белых списках». Что-то не открывается? Просто переключись.',
    `Доступ действует до ${formatVpnExpiry(params.expireAt)}. ${traffic}`,
  ].join('\n');
}

/**
 * Ответ на callback `channel`. Кнопка канала в новых меню — url-кнопка, но у
 * пользователей остались отправленные раньше сообщения с callback-заглушкой:
 * им отвечаем ссылкой, а не «канала ещё нет».
 */
export const CHANNEL_LINK_TEXT = `Наш канал: ${TELEGRAM_CHANNEL_URL} — новости сервиса, акции и подсказки по оплате зарубежных подписок.`;

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

/**
 * Предупреждение о комиссии платёжной системы в сообщении со ссылкой на оплату.
 * `null` — текущий шлюз надбавку не берёт (тогда строки в сообщении нет).
 * Формулировка совпадает с веб-экранами (`lib/payments/buyer-fee.ts`).
 */
export function buildBuyerFeeLine(feePercent: number, totalKopecks?: number): string | null {
  // Сумма известна не везде: на кнопочном пути под рукой только результат
  // confirm_order (ссылка + срок), и тянуть заказ из БД ради строки текста
  // не стоит — тогда показываем процент без итоговой цифры.
  const note =
    totalKopecks === undefined
      ? buyerFeeNote(feePercent)
      : buyerFeeAmountNote(totalKopecks, feePercent, formatRub);
  return note === null ? null : `Важно: ${note}`;
}

/** Каталог не открылся (БД/курс недоступны). */
export const CATALOG_UNAVAILABLE_TEXT =
  'Каталог сейчас не открылся. Попробуй ещё раз через минуту или напиши, что нужно, текстом — оформлю вручную.';

/**
 * Совет про НДС/VPN — показываем на ЛЮБОМ сервисе (и тарифы, и custom-amount),
 * чтобы реальный charge не вырос из-за локального налога: подписка $100 из-за
 * локации может списаться как $111. Под US VPN — без НДС. Страну выпуска карты
 * публично не указываем (ТЗ «клиентский путь» §2) — только локацию VPN.
 */
export const VAT_VPN_HINT =
  'Платим виртуальной картой без НДС. На сайте сервиса включи VPN с локацией США — иначе из-за локации спишется больше (например, подписка $100 обойдётся в $111).';

/**
 * Короткий блок правил оплаты картой (parse_mode HTML) для финального сообщения
 * `issue-card` — и при выпуске новой карты, и при пополнении существующей.
 * Показывает точную цену подписки в долларах (сколько ввести на сайте) и три
 * правила, из-за которых чаще всего не проходит оплата. Подробности — на
 * странице-инструкции (url-кнопка добавляется рядом с сообщением).
 *
 * Без user-input — статический текст + `formatUsd` (только `$`/цифры),
 * экранирование не требуется.
 */
export function paymentRulesHtml(priceUsdCents: number): string {
  return [
    `<b>Оплатить строго по цене ${formatUsd(priceUsdCents)}</b> — это цена сервиса в США.`,
    '',
    'Чтобы оплата прошла с первого раза:',
    '• оплачивай в веб-версии сервиса — в браузере, не в мобильном приложении;',
    '• включи VPN с локацией <b>США</b> и выбери страну США на сайте сервиса;',
    '• плати в долларах по американской цене — в евро или рублях дороже из-за налога, и денег на карте не хватит;',
    '• если на сайте всё ещё старая цена — очисти кэш этого сайта и зайди заново по VPN.',
    '',
    'Пошагово, для iPhone / Android / компьютера — по кнопке ниже.',
  ].join('\n');
}

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

/**
 * Маскирует последовательности, похожие на номер карты (12–19 цифр, допустимы
 * пробелы/дефисы между группами), в свободном тексте клиента: полный PAN не
 * должен попадать даже в DM оператору (политика «PAN/CVC не логируются
 * никогда»). Оставляем последние 4 цифры — оператору хватает для сверки.
 */
export function redactCardNumbers(text: string): string {
  return text.replace(/(?:\d[ -]?){11,18}\d/g, (match) => {
    const digits = match.replace(/\D/g, '');
    return `**** ${digits.slice(-4)}`;
  });
}

/**
 * Сообщение оператору о проблеме с оплатой на сайте сервиса («Не проходит
 * оплата?» в кабинете, ТЗ §6). В поддержку автоматически передаётся весь
 * контекст: номер заказа, сервис, тариф, сумма, статус карты и тип ошибки.
 * Чистая функция — тестируется без бота; пользовательские поля экранируются,
 * PAN-подобные последовательности в комментарии маскируются, комментарий
 * обрезается по бюджету Telegram (после экранирования).
 */
export function buildPaymentIssueOperatorMessage(params: {
  /** Числовой Telegram ID (в кабинете приходит строкой из проверенного initData). */
  telegramId: number | string;
  displayName?: string | null;
  orderShortId: string;
  service: string;
  tierName?: string | null;
  amountKopecks?: number | null;
  cardStatusLabel?: string | null;
  issueType: PaymentIssueType;
  comment?: string | null;
}): string {
  const nameLine =
    params.displayName && params.displayName.length > 0
      ? escapeHtml(params.displayName)
      : 'без имени';
  const rows = [
    '⚠️ <b>Не проходит оплата на сайте сервиса</b>',
    '',
    `<b>Клиент:</b> ${nameLine}`,
    `<b>Telegram ID:</b> <code>${params.telegramId}</code>`,
    `<b>Профиль:</b> <a href="tg://user?id=${params.telegramId}">открыть чат</a>`,
    '',
    `<b>Заказ:</b> ${escapeHtml(params.orderShortId)}`,
    `<b>Сервис:</b> ${escapeHtml(params.service)}`,
    ...(params.tierName ? [`<b>Тариф:</b> ${escapeHtml(params.tierName)}`] : []),
    ...(params.amountKopecks !== null && params.amountKopecks !== undefined
      ? [`<b>Сумма заказа:</b> ${formatRub(params.amountKopecks)}`]
      : []),
    ...(params.cardStatusLabel
      ? [`<b>Статус карты:</b> ${escapeHtml(params.cardStatusLabel)}`]
      : []),
    `<b>Тип проблемы:</b> ${PAYMENT_ISSUE_LABELS[params.issueType]}`,
  ];
  const header = rows.join('\n');
  const comment = params.comment?.trim();
  if (!comment) return header;
  const commentHeader = '\n\n<b>Комментарий клиента:</b>\n';
  // -1 — запас под «…», добавляемый при обрезке.
  const bodyBudget = Math.max(
    0,
    Math.min(
      SUPPORT_MESSAGE_MAX_LEN,
      TELEGRAM_MESSAGE_LIMIT - header.length - commentHeader.length - 1,
    ),
  );
  const safeComment = redactCardNumbers(comment);
  return header + commentHeader + truncateEscapedHtml(escapeHtml(safeComment), bodyBudget);
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

/** Дата оформления заказа для уведомлений: «19 июля» (Europe/Moscow, как formatExpires). */
function formatOrderDate(date: Date): string {
  try {
    return date.toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'long',
    });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Уведомление «срок оплаты истёк» (cron expire-payments). Вместо внутреннего
 * номера ORD-XXXXX (решение владельца 2026-07-19: клиенту он ни о чём) —
 * название сервиса, сумма и дата оформления. Фоллбеки: без названия —
 * нейтральный «заказ», без суммы — сумма опускается.
 */
export function buildOrderExpiredMessage(input: {
  serviceLabel: string | null;
  amountKopecks: number | null;
  createdAt: Date;
}): string {
  const label = input.serviceLabel ?? 'заказ';
  const amount =
    input.amountKopecks !== null && input.amountKopecks > 0
      ? ` на ${formatRub(input.amountKopecks)}`
      : '';
  return (
    `Срок оплаты истёк: ${label}${amount}, оформлен ${formatOrderDate(input.createdAt)}. ` +
    'Если ещё актуально — напишите /start, оформим заново.'
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
