/**
 * Telegram документирует telegram.me как официальный HTTPS alias deep-link'ов.
 * Держим origin централизованно, чтобы пользовательские потоки не расходились.
 */
export const TELEGRAM_WEB_ORIGIN = 'https://telegram.me';

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
