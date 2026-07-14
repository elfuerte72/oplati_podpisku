import 'server-only';

import { serverEnv } from '@/lib/env';
import { telegramBotLink, telegramMiniAppLink } from '@/lib/telegram/links';

/**
 * Telegram deep-link'и, которые зависят от short name зарегистрированного в
 * BotFather Mini App. Держим в одном месте: short name задаёт формат сразу двух
 * ссылок (кабинет с сайта и реф-приглашение), но включаются они РАЗНЫМИ флагами.
 */

/**
 * Ссылка на Mini App-кабинет для кнопки «Личный кабинет» на сайте (веб-браузер
 * не умеет открывать web_app-кнопку — только сам Telegram).
 *
 * Short name задан → прямая ссылка через telegram.me: кабинет открывается одним тапом.
 * Не задан → deep-link на бота с `?start=cabinet`: пользователь попадает в
 * /start-меню, где есть web_app-кнопка «Открыть приложение». Payload `cabinet`
 * для бота — обычный неизвестный payload (не `link_`/`ref_`), обрабатывается
 * как чистый `/start`.
 */
export function cabinetDeepLink(botUsername: string): string {
  const shortName = serverEnv.TELEGRAM_MINIAPP_SHORTNAME;
  return shortName
    ? telegramMiniAppLink(botUsername, shortName)
    : telegramBotLink(botUsername, 'cabinet');
}

/**
 * Short name для реф-ссылки приглашения — только если явно включён
 * `REFERRAL_MINIAPP_DEEPLINK`. Иначе `null`, и `formatReferralTelegramLink`
 * собирает telegram.me bot-deep-link `?start=ref_<code>` (друг видит бота и приветствие).
 */
export function referralMiniAppShortName(): string | null {
  if (!serverEnv.REFERRAL_MINIAPP_DEEPLINK) return null;
  return serverEnv.TELEGRAM_MINIAPP_SHORTNAME ?? null;
}
