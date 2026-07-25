import 'server-only';

import { serverEnv } from '@/lib/env.server';

/**
 * URL-хелперы деплоя в одном месте, чтобы Vercel-логика не разъезжалась между
 * стартовым меню бота (`handle-update.ts`) и джобами (`issue-card.ts` шлёт
 * ссылку на инструкцию по оплате в финальном сообщении).
 *
 * База без завершающего слэша: production — стабильный `APP_URL`
 * (`https://www.oplatishka.com`); preview — собственный host деплоя
 * (`VERCEL_URL`), чтобы smoke-тест dev-бота открывал именно свой preview
 * (тот же приём, что self-call в confirm-order).
 */
export function deploymentBaseUrl(): string {
  const ownHost = process.env.VERCEL_URL;
  return process.env.VERCEL_ENV === 'production' || !ownHost
    ? serverEnv.APP_URL.replace(/\/$/, '')
    : `https://${ownHost}`;
}

/**
 * База для Mini App-кабинета. На production — прямой Vercel-домен
 * (`MINIAPP_BASE_URL`, напр. `oplati-podpisku-web.vercel.app`), МИМО
 * reverse-proxy (Timeweb): кабинет открывается только из Telegram, где у РФ-
 * пользователя VPN уже есть, а лишний хоп через прокси лишь добавляет задержку
 * и завязку на Timeweb. Не задан → fallback на `deploymentBaseUrl()` (кабинет
 * через прокси, как было). Preview/локально — собственный host деплоя.
 */
function miniAppBaseUrl(): string {
  if (process.env.VERCEL_ENV === 'production') {
    const direct = serverEnv.MINIAPP_BASE_URL;
    return direct ? direct.replace(/\/$/, '') : deploymentBaseUrl();
  }
  return deploymentBaseUrl();
}

/**
 * База для ВНУТРЕННЕГО self-call'а (`/api/payments/create` из confirm_order).
 *
 * Живёт здесь, а не по месту вызова: этот модуль — единственный источник правды
 * о «своём базовом URL», иначе self-host-ветка и Vercel-ветка разъезжаются
 * (находка D-2). Отличается от `deploymentBaseUrl()` намеренно:
 *   1. `SELF_BASE_URL` (self-host/Dokploy — `http://127.0.0.1:3000`): денежный
 *      вызов замыкается внутри контейнера, не выходя в интернет и не завися от
 *      Traefik/DNS/сертификата;
 *   2. `VERCEL_URL` — собственный host деплоя. На preview `APP_URL` смотрит на
 *      production (где нет L&P-ключей и своего INTERNAL_API_TOKEN), поэтому
 *      self-call на `APP_URL` поймал бы 401;
 *   3. `APP_URL` — fallback для локальной разработки.
 * Разница с `deploymentBaseUrl()`: там на production принудительно `APP_URL`
 * (публичная ссылка для пользователя), здесь — приоритет собственного хоста.
 */
export function selfCallBaseUrl(): string {
  const selfBase = serverEnv.SELF_BASE_URL;
  if (selfBase) return selfBase.replace(/\/$/, '');

  const ownHost = process.env.VERCEL_URL;
  if (ownHost) return `https://${ownHost}`;

  return serverEnv.APP_URL.replace(/\/$/, '');
}

/** URL Mini App для web_app-кнопки стартового меню (открывает /cabinet). */
export function miniAppUrl(): string {
  return `${miniAppBaseUrl()}/cabinet`;
}

/** URL главного сайта (корень) для url-кнопки «Сайт» в /start. */
export function siteUrl(): string {
  return deploymentBaseUrl();
}

/**
 * URL страницы-инструкции по оплате (`public/payment-instruction.html`).
 * Статический лендинг одинаков на prod и preview — ссылка ведёт на текущий
 * деплой. Кладётся url-кнопкой в финальное сообщение с картой и в меню /start.
 */
export function paymentInstructionUrl(): string {
  return `${deploymentBaseUrl()}/payment-instruction.html`;
}
