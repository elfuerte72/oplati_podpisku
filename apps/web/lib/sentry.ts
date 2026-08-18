import type * as SentryTypes from '@sentry/nextjs';

/**
 * Общие хелперы Sentry для client/server/edge.
 *
 * Основная задача — `beforeSend`-скраббер, который вычищает PII по денилисту
 * из `docs/observability.md`:
 *   content, message, text, email, phone, card, password, token.
 *
 * Применяется на всех трёх runtime'ах (client/server/edge).
 */

// Карточные реквизиты (pan/cvc/cvv/cardNo) и auth-строки (initData/signature) —
// аудит 2026-07-11 F-06: страховочный слой, код их в Sentry не отправляет.
// `tel`/`last_seen_ip` — антифрод-трек (Р5): контакты и адрес клиента уходят
// провайдеру, но не во внешние сервисы наблюдаемости.
const PII_KEY_RE =
  /^(content|message|text|email|phone|tel|card|password|token|pan|cvc|cvv|card_?no|init_?data|signature|last_?seen_?ip)$/i;

/** Рекурсивно редактирует значения PII-полей во вложенных объектах. */
function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEY_RE.test(k) ? '[REDACTED]' : scrubPii(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Скраббер СВОБОДНОГО ТЕКСТА: заголовок события и текст исключения.
 *
 * Денилист по ключам их не покрывает — там нет ключей, только строка. А именно
 * туда сырое тело ответа платёжного шлюза и попадает: клиенты Freekassa и L&P
 * кладут в `message` ошибки `respText.slice(0, 500)` при дрейфе контракта. То
 * есть закрыв `rawBody` (неперечисляемое свойство), мы оставили бы открытым
 * соседний канал — заголовок issue в Sentry (находка ревью 2026-08-11).
 *
 * Маскируем PAN-подобные последовательности (13–19 цифр с любыми обычными
 * разделителями) и `Bearer`-токены. Здесь без контрольной суммы Луна: это
 * машинный текст, а не сообщение клиента, и потерять точность цифр в отладочной
 * строке дешевле, чем отправить номер карты в внешний сервис.
 */
function scrubText(text: string): string {
  return text
    .replace(/\d(?:[ .\-/]?\d){12,18}/g, (match) => `**** ${match.replace(/\D/g, '').slice(-4)}`)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
}

/**
 * Денилист параметров строки запроса.
 *
 * `q` — поиск в админ-панели: плейсхолдер прямо предлагает искать по email и
 * телефону, то есть параметр по построению несёт контакт клиента (режим PAN,
 * как `users.email`/`users.phone` в антифрод-треке).
 */
function scrubQueryString(query: string): string {
  return (
    query
      .replace(
        /(content|message|text|email|phone|card|password|token|signature|init_?data)=[^&]*/gi,
        '$1=[REDACTED]',
      )
      // `?s=` — секрет алёрт-вебхука Sentry (/api/alerts/sentry). Отдельным
      // выражением с якорем на границу параметра, чтобы не задевать `tags=` и т.п.
      .replace(/(^|[?&])s=[^&]*/gi, '$1s=[REDACTED]')
      // `?q=` — по той же схеме: якорь на границу параметра, иначе выражение
      // задело бы `seq=`, `uniq=` и прочее.
      .replace(/(^|[?&])q=[^&]*/gi, '$1q=[REDACTED]')
  );
}

/** Тот же денилист для строки запроса внутри полного URL. */
function scrubUrl(url: string): string {
  const cut = url.indexOf('?');
  if (cut === -1) return url;
  return `${url.slice(0, cut)}?${scrubQueryString(url.slice(cut + 1))}`;
}

export type SentryEvent = SentryTypes.ErrorEvent;
export type SentryHint = SentryTypes.EventHint;

export function beforeSend(event: SentryEvent): SentryEvent | null {
  // Request body / query / headers — денилист PII
  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubPii(event.request.data) as typeof event.request.data;
    }
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      event.request.query_string = scrubQueryString(event.request.query_string);
    }
    // URL несёт ТУ ЖЕ строку запроса, а чистился только `query_string` — то есть
    // денилист обходился сам собой (находка ревью пачки 2 админ-панели).
    // Поводом стал поиск в панели: менеджер ищет клиента по email или телефону,
    // строка уезжает в `?q=`, и любая ошибка рендера отправляла бы контакт
    // клиента во внешний сервис — а `LiveRefresh` повторяет тот же адрес каждые
    // 25 секунд.
    if (typeof event.request.url === 'string') {
      event.request.url = scrubUrl(event.request.url);
    }
    // ⚠️ `cookies` — ОТДЕЛЬНОЕ поле, и чистки заголовка `cookie` ему мало:
    // интеграция requestData разбирает заголовок в объект ещё ДО `beforeSend`
    // (`cookies: true` в её дефолтах). Там лежит подписанная cookie сессии
    // панели — bearer на 12 часов, который нечем отозвать поштучно: таблицы
    // сессий нет, а `staff.is_active = false` выключает живого сотрудника.
    // Любое исключение на `/admin/*` отправляло бы этот токен во внешний сервис.
    if (event.request.cookies) {
      event.request.cookies = {};
    }
    if (event.request.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const key of Object.keys(headers)) {
        // `x-telegram-init-data` — подписанная initData Mini App: живёт 24 часа
        // и её достаточно для `/api/cabinet` `card-details`, то есть для показа
        // PAN+CVC чужой карты. `/api/cabinet` возит её в ТЕЛЕ (там ловит
        // денилист `init_?data`), а `/api/analytics` — заголовком, поэтому без
        // этого имени в списке она уезжала бы в Sentry целиком (найдено
        // ревью 2026-07-30).
        if (
          /authorization|cookie|x-telegram-bot-api-secret-token|x-alert-token|x-telegram-init-data/i.test(
            key,
          )
        ) {
          headers[key] = '[REDACTED]';
        }
      }
    }
  }

  // Breadcrumbs
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data) {
        crumb.data = scrubPii(crumb.data) as typeof crumb.data;
        // ⚠️ `scrubPii` смотрит на ИМЕНА ключей, а адрес живёт в `url`/`to`/
        // `from` — имена невинные. Поиск в панели кладёт email и телефон
        // клиента в `?q=`, и навигационная крошка возит их каждые 25 секунд.
        for (const key of ['url', 'to', 'from'] as const) {
          const value = (crumb.data as Record<string, unknown>)[key];
          if (typeof value === 'string') {
            (crumb.data as Record<string, unknown>)[key] = scrubUrl(value);
          }
        }
      }
      if (crumb.message) {
        // превентивная обрезка потенциальных токенов в сообщениях
        crumb.message = crumb.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
      }
    }
  }

  // Extra / contexts / tags
  if (event.extra) {
    event.extra = scrubPii(event.extra) as typeof event.extra;
  }
  // `contexts` и `tags` чистились не всегда, хотя комментарий обещал обратное
  // (аудит 2026-08-10). Они наполняются не только нашим кодом: SDK и интеграции
  // складывают туда свои структуры, а `Sentry.captureException(err, { extra })`
  // соседствует с `setContext`/`setTag` из тех же денежных путей.
  if (event.contexts) {
    event.contexts = scrubPii(event.contexts) as typeof event.contexts;
  }
  if (event.tags) {
    event.tags = scrubPii(event.tags) as typeof event.tags;
  }

  // Свободный текст: заголовок события и текст исключения. Именно сюда клиенты
  // платёжных шлюзов кладут сырое тело ответа при дрейфе контракта.
  if (typeof event.message === 'string') {
    event.message = scrubText(event.message);
  }
  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === 'string') value.value = scrubText(value.value);
    }
  }

  return event;
}

export function resolveEnvironment(): 'development' | 'preview' | 'production' | string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
}

/** Экспорт для явного импорта в sentry.*.config.ts. */
export const sharedOptions = {
  environment: resolveEnvironment(),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  beforeSend,
} as const;
