'use client';

import {
  ANALYTICS_MAX_BATCH,
  type AnalyticsEventName,
  type AnalyticsProps,
} from '@oplati/types';

/**
 * Клиентская отправка поведенческих событий.
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ: не мешать пользователю. Телеметрия не имеет права
 * задержать переход, клик или рендер, поэтому:
 *   - отправка через `sendBeacon` (браузер довозит её сам, даже если вкладка
 *     уже закрывается — иначе события «ушёл на сайт сервиса» и «нажал
 *     Оплатить», самые интересные, терялись бы ровно всегда);
 *   - `fetch(keepalive)` — запасной путь там, где beacon недоступен;
 *   - события копятся в очереди и уходят пачкой (мелкий debounce), а на
 *     `pagehide` очередь сбрасывается принудительно;
 *   - ни один вызов ничего не бросает и ничего не ждёт.
 */

const ENDPOINT = '/api/analytics';
const FLUSH_DELAY_MS = 1500;
/** Конвенция проекта: `fetch` без таймаута запрещён. keepalive это не ломает. */
const REQUEST_TIMEOUT_MS = 10_000;

type QueuedEvent = {
  eventKey: string;
  name: AnalyticsEventName;
  channel: 'web' | 'miniapp';
  occurredAt: string;
  props?: AnalyticsProps;
  orderRef?: string;
};

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function newEventKey(): string {
  // Ключ идемпотентности: ретрай beacon и двойной клик не должны удваивать
  // воронку. crypto.randomUUID есть во всех целевых браузерах; фолбэк — на
  // случай http-контекста (localhost без TLS).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function isMiniApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.Telegram?.WebApp?.initData);
}

function send(events: QueuedEvent[]): void {
  if (events.length === 0) return;
  const body = JSON.stringify({ events });

  // В Mini App подпись initData едет заголовком — значит beacon не годится
  // (он не умеет заголовки), только fetch с keepalive.
  const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
  if (initData) {
    void fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(reportTransportFailure);
    return;
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    if (ok) return;
  }

  void fetch(ENDPOINT, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(reportTransportFailure);
}

/**
 * Отказ транспорта сообщаем РОВНО ОДИН раз за загрузку страницы.
 *
 * Молчаливый `catch` здесь был бы худшим вариантом из возможных: полностью
 * сломанный приём (CSP, 4xx на весь батч, блокировщик) выглядел бы ровно как
 * «никто ничего не нажимал», и заметили бы это только по пустой воронке.
 * Но и слать по событию на каждый батч нельзя — отвалившаяся сеть устроила бы
 * шторм в Sentry.
 */
let transportFailureReported = false;
function reportTransportFailure(err: unknown): void {
  if (transportFailureReported) return;
  transportFailureReported = true;
  void import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.captureException(err, { tags: { source: 'analytics.client_transport' } });
    })
    .catch(() => undefined);
}

export function flushAnalytics(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = queue;
  queue = [];
  send(batch);
}

function bindLifecycleListeners(): void {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;
  // `pagehide` вместо `beforeunload`: на мобильных Safari второй не срабатывает,
  // а именно там уходят по ссылке на страницу провайдера.
  window.addEventListener('pagehide', flushAnalytics);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAnalytics();
  });
}

/**
 * Записать событие. Никогда не бросает и ничего не ждёт — вызывать можно прямо
 * в обработчике клика перед навигацией.
 */
export function track(
  name: AnalyticsEventName,
  props?: AnalyticsProps,
  opts?: { orderRef?: string; immediate?: boolean },
): void {
  try {
    if (typeof window === 'undefined') return;
    bindLifecycleListeners();

    const event: QueuedEvent = {
      eventKey: newEventKey(),
      name,
      channel: isMiniApp() ? 'miniapp' : 'web',
      occurredAt: new Date().toISOString(),
      ...(props && Object.keys(props).length > 0 ? { props } : {}),
      ...(opts?.orderRef ? { orderRef: opts.orderRef } : {}),
    };
    queue.push(event);

    // Уход из приложения (оплата, сайт сервиса, Telegram) — отправляем сразу:
    // ждать debounce там некому, вкладка уже закрывается.
    if (opts?.immediate || queue.length >= ANALYTICS_MAX_BATCH) {
      flushAnalytics();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushAnalytics, FLUSH_DELAY_MS);
    }
  } catch {
    // Телеметрия не имеет права сломать UI. Логировать в консоль тоже не будем:
    // console.* запрещён конвенцией, а Sentry ради потерянного клика избыточен.
  }
}
