/**
 * Публичные реквизиты сервиса для информационных страниц (/about, /terms,
 * /privacy) и футеров сайта/мини-аппа. Страницы — требование платёжного
 * провайдера: публичные документы с датой редакции + контакты поддержки.
 *
 * Даты редакций обновлять при КАЖДОМ содержательном изменении текста
 * соответствующего документа.
 */

export const SUPPORT_TELEGRAM = '@OplatishkaSupport_bot';
export const SUPPORT_TELEGRAM_URL = 'https://telegram.me/OplatishkaSupport_bot';
export const SUPPORT_EMAIL = 'oplatishka.general@gmail.com';

/** Дата действующей редакции Пользовательского соглашения. */
export const TERMS_UPDATED_AT = '24 июля 2026 года';
/** Дата действующей редакции Политики конфиденциальности. */
export const PRIVACY_UPDATED_AT = '24 июля 2026 года';

/**
 * Канонический публичный домен сайта — для ссылок из Mini App: кабинет живёт
 * на другом хосте, относительные ссылки на документы оттуда не работают.
 */
export const SITE_ORIGIN = 'https://www.oplatishka.com';
