import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { buildProxyFetch, proxyHostForLog } from '../loveandpay/proxy-fetch.ts';

const log = childLogger('lnp-proxy-health');

/**
 * Healthcheck CONNECT-прокси L&P (H-3 аудита 2026-07-18: SPOF приёма денег).
 *
 * Squid на единственном VPS — единственный путь исходящих запросов к L&P
 * (allowlist по IP: прямое соединение получает SOURCE_IP_NOT_ALLOWED). VPS
 * упал → createInvoice падает у всех клиентов, а узнали бы мы об этом от них.
 * Проверка зовётся из cron `poll-payment` (каждые 5 минут): HEAD через прокси
 * к origin L&P — ЛЮБОЙ HTTP-ответ означает, что CONNECT прошёл и прокси жив;
 * сетевая ошибка/таймаут — алёрт.
 *
 * Это мониторинг: ошибка проверки не влияет на основной результат cron'а
 * (паттерн vcc-balance — ловим всё, наружу не бросаем).
 */

const HEALTHCHECK_TIMEOUT_MS = 5_000;

// Best-effort дедуп DM владельцу на warm-инстансе: пока прокси лежит, cron
// зовёт нас каждые 5 минут — Sentry группирует сам, а вот личку заспамили бы.
// На холодном инстансе счётчик обнуляется — в худшем случае лишний DM.
const OPS_DM_DEDUP_MS = 60 * 60 * 1000;
let lastOpsDmAt = 0;

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetProxyAlertDedupForTests(): void {
  lastOpsDmAt = 0;
}

export async function alertOnLoveAndPayProxyDown(deps?: {
  /** Инъекция для unit-тестов; в проде строится из LOVEANDPAY_PROXY_URL. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const proxyUrl = serverEnv.LOVEANDPAY_PROXY_URL;
  if (!proxyUrl) return; // dev/тесты ходят в L&P напрямую — мониторить нечего

  const timeoutMs = deps?.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS;
  const proxyHost = proxyHostForLog(proxyUrl);

  try {
    const fetchImpl = deps?.fetchImpl ?? buildProxyFetch(proxyUrl);
    const targetOrigin = new URL(serverEnv.LOVEANDPAY_BASE_URL).origin;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Любой HTTP-статус (включая 3xx/4xx/5xx от самого L&P) = CONNECT прошёл,
      // прокси жив. Нас интересует только транспорт, не приложение.
      // redirect: 'manual' обязателен (инцидент 2026-07-19): origin L&P стал
      // отвечать 307-цепочкой, follow упирался в «redirect count exceeded» /
      // таймаут — и здоровый прокси всю ночь считался лежащим (ложные DM).
      await fetchImpl(targetOrigin, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });
      log.info({ event: 'lnp_proxy.ok', proxy: proxyHost });
      return;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    log.error({ event: 'lnp_proxy.down', proxy: proxyHost, err });
    Sentry.captureMessage('L&P CONNECT-прокси недоступен — приём платежей под угрозой', {
      level: 'error',
      tags: { source: 'lnp-proxy-health', alert: 'lnp_proxy_down' },
      // proxyHost — только host:port, без credentials из URL.
      extra: { proxy: proxyHost },
    });

    const now = Date.now();
    if (now - lastOpsDmAt >= OPS_DM_DEDUP_MS) {
      lastOpsDmAt = now;
      // notifyOps глотает ошибки доставки сам, но страхуемся: сбой DM не
      // должен уронить cron (Sentry-алёрт выше уже ушёл). Без captureException
      // — анти-петля, как в notify-ops.ts.
      try {
        await notifyOps(
          `КРИТИЧНО: прокси L&P (${proxyHost}) не отвечает — создание счетов на оплату падает у всех клиентов. Проверь VPS (squid) и при необходимости переключи LOVEANDPAY_PROXY_URL + redeploy.`,
        );
      } catch (notifyErr) {
        log.error({ event: 'lnp_proxy.notify_failed', err: notifyErr });
      }
    }
  }
}
