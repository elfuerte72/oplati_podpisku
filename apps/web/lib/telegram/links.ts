/**
 * Telegram документирует telegram.me как официальный HTTPS alias deep-link'ов.
 * Держим origin централизованно, чтобы пользовательские потоки не расходились.
 */
export const TELEGRAM_WEB_ORIGIN = 'https://telegram.me';

/**
 * Payload deep-link'а входа в поддержку: `telegram.me/<bot>?start=support`.
 * Им пользуются Mini App и сайт — у обоих нет своего канала связи с клиентом,
 * а отвечает помощник только в Telegram.
 *
 * ⚠️ Живёт в ЛИСТЕ, а не рядом с обработчиком `/start`. `deep-links.ts` тянут
 * `/api/profile` и оба роута кабинета; импорт константы из `start-menu.ts`
 * притащил бы за ней весь граф бота — grammY, `@oplati/db`, Sentry — в роуты,
 * которым ничего этого не нужно.
 */
export const SUPPORT_START_PAYLOAD = 'support';

export function telegramBotLink(botUsername: string, start?: string): string {
  const base = `${TELEGRAM_WEB_ORIGIN}/${botUsername}`;
  return start ? `${base}?start=${encodeURIComponent(start)}` : base;
}

export function telegramMiniAppLink(
  botUsername: string,
  shortName: string,
  startApp?: string,
): string {
  const base = `${TELEGRAM_WEB_ORIGIN}/${botUsername}/${shortName}`;
  return startApp ? `${base}?startapp=${encodeURIComponent(startApp)}` : base;
}

export function telegramShareLink(url: string, text: string): string {
  return `${TELEGRAM_WEB_ORIGIN}/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
