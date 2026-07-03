import 'server-only';

import { serverEnv } from '@/lib/env';

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

/** URL Mini App для web_app-кнопки стартового меню (открывает /cabinet). */
export function miniAppUrl(): string {
  return `${deploymentBaseUrl()}/cabinet`;
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
