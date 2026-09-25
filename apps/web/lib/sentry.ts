import type * as SentryTypes from '@sentry/nextjs';

/**
 * Общие хелперы Sentry для client/server/edge.
 *
 * Основная задача — `beforeSend`-скраббер, который вычищает PII по денилисту
 * (денилист живёт здесь же; куда смотреть — `docs/runbooks/monitoring.md`):
 *   content, message, text, email, phone, card, password, token.
 *
 * Применяется на всех трёх runtime'ах (client/server/edge).
 */

// Карточные реквизиты (pan/cvc/cvv/cardNo) и auth-строки (initData/signature) —
// аудит 2026-07-11 F-06: страховочный слой, код их в Sentry не отправляет.
// `tel`/`last_seen_ip` — антифрод-трек (Р5): контакты и адрес клиента уходят
// провайдеру, но не во внешние сервисы наблюдаемости.
// ⚠️ `query`/`q` — поисковая строка панели (v3). Раньше она приезжала только в
// адресе и её чистил `scrubQueryString`; быстрый поиск и выгрузка шлют её ТЕЛОМ
// запроса, а тело разбирается в `request.data` — то есть перенос поиска на POST
// закрыл один канал и открыл соседний. Плейсхолдер поля прямо предлагает искать
// по почте и телефону, поэтому ключ несёт контакт клиента по построению.
// `promo_code` — не PII, но ДЕЙСТВУЮЩИЙ КОД СКИДКИ: он приходит телом POST и
// без чистки уехал бы во внешний сервис с любым исключением в `/api/cabinet`
// или `/api/payments/create` — вместе с ещё не объявленной акцией (трек
// promo-codes, находка ревью).
const PII_KEY_RE =
  /^(content|message|text|email|phone|tel|card|password|token|pan|cvc|cvv|card_?no|init_?data|signature|last_?seen_?ip|query|q|http\.query|telegram_?username|chat_?id|promo_?code)$/i;

/**
 * Денилист ТЕЛА запроса — шире общего.
 *
 * `code` — шесть цифр второго фактора панели (`/api/panel/auth/totp`), `hash` —
 * подпись первого фактора. В общий денилист их не кладём намеренно: он чистит и
 * `extra`/`contexts`, где `code` — это код ошибки (`ECONNREFUSED`, код Postgres),
 * без которого событие теряет смысл. А в теле запроса поле с таким именем несёт
 * секрет входа.
 *
 * Остальное — поля тел, которые реально приходят к нам: `phone_number` —
 * контакт из `request_contact` в апдейте бота, `username`/`first_name`/
 * `last_name` — профиль `from` того же апдейта, `question` — вопрос AI-аналитику
 * (владелец пишет туда почту клиента), `comment` — комментарий ручной выдачи
 * (ревью 2026-09-25, ось C). `id` не берём: иначе из события пропадут номера
 * заказов, по которым его и разбирают.
 */
const BODY_KEY_RE = new RegExp(
  `${PII_KEY_RE.source}|^(code|totp|otp|hash|phone_?number|username|first_?name|last_?name|question|comment)$`,
  'i',
);

/**
 * Атрибут спана, в который интеграция requestData кладёт ТЕЛО запроса строкой
 * (`@sentry/core` 10.53, режим потоковой отправки спанов). По имени ключа общий
 * денилист его не узнаёт, а значение — сырое тело.
 */
const BODY_ATTR_RE = /^http\.request\.body/i;

/** Рекурсивно редактирует значения PII-полей во вложенных объектах. */
function scrubPii(value: unknown, depth = 0, keyRe: RegExp = PII_KEY_RE): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, depth + 1, keyRe));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyRe.test(k)) out[k] = '[REDACTED]';
      else if (BODY_ATTR_RE.test(k)) out[k] = scrubRequestBody(v);
      else out[k] = scrubPii(v, depth + 1, keyRe);
    }
    return out;
  }
  return value;
}

/** Похоже на `application/x-www-form-urlencoded`: пары `ключ=значение` без пробелов. */
const FORM_BODY_RE = /^[\w.%+\-[\]]+=[^\s&]*(?:&[\w.%+\-[\]]+=[^\s&]*)*$/;

/** Разбор JSON без исключения наружу: не-JSON — штатный исход, а не ошибка. */
function parseJsonObject(text: string): object | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Не JSON — значит форма или мусор; решает вызывающий. Логировать здесь
    // нечем и незачем: мы внутри хука Sentry, и ошибка разбора тела клиента
    // не событие.
    return null;
  }
}

/**
 * Второй эшелон чистки ТЕЛА запроса.
 *
 * Первый — выключенный перехват тела в `sentry.server.config.ts`. Этот нужен на
 * случай, если тело всё-таки приедет: SDK кладёт его СТРОКОЙ (`@sentry/node-core`
 * `captureRequestBody`), а денилист по ключам строку пропускал как есть — то есть
 * поиск ⌘K по почте, код TOTP, `initData` кабинета и текст ответа оператора
 * уезжали во внешний сервис целиком (аудит CRM 2026-09-17, тикет 06).
 *
 * JSON — разбираем и чистим по ключам; форма — денилистом строки запроса; всё
 * остальное (обрезанное SDK тело, текст, мусор) — целиком: разобрать нельзя,
 * значит и доказать, что в нём нет PII, нельзя.
 */
function scrubRequestBody(data: unknown): unknown {
  if (typeof data !== 'string') return scrubPii(data, 0, BODY_KEY_RE);
  const trimmed = data.trim();
  if (trimmed === '') return data;
  const parsed = parseJsonObject(trimmed);
  if (parsed) return JSON.stringify(scrubPii(parsed, 0, BODY_KEY_RE));
  if (FORM_BODY_RE.test(trimmed)) return scrubQueryString(trimmed);
  return '[REDACTED]';
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
  return (
    text
      .replace(/\d(?:[ .\-/]?\d){12,18}/g, (match) => `**** ${match.replace(/\D/g, '').slice(-4)}`)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
      // Сообщение об ошибке транспорта несёт адрес целиком («request to
      // https://api.telegram.org/bot<token>/… failed»), а токен стоит ДО `?`.
      .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[REDACTED]')
  );
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
      // Первый фактор панели: Telegram Login Widget возвращает профиль
      // сотрудника и подпись GET-параметрами на `/api/panel/auth/telegram`,
      // второй — форма `code=` на `/api/panel/auth/totp`. Плюс поля тела,
      // которые встречаются в формах. Тоже с якорем: `id=` без него задел бы
      // `orderid=`, а `code=` — `promocode=` (тот и так в списке).
      .replace(
        /(^|[?&])(code|hash|auth_date|id|username|first_name|last_name|photo_url|query|tel|pan|cvc|cvv|card_?no|promo_?code|last_?seen_?ip)=[^&]*/gi,
        '$1$2=[REDACTED]',
      )
  );
}

/**
 * Токен бота в ПУТИ адреса Bot API: `https://api.telegram.org/bot<token>/getChat`.
 *
 * ⚠️ Денилист строки запроса тут бессилен — секрет стоит до `?`. А инструментация
 * исходящих запросов Sentry кладёт путь в http-крошку и в атрибут спана целиком
 * (она чистит только query и `user:pass@`), поэтому один необработанный сбой на
 * любом пути, ходящем в Telegram — а это КАЖДАЯ отправка сообщения клиенту, —
 * увозил бы во внешний сервис токен, который равен чтению всех клиентских чатов
 * и отправке от имени бота. Найдено ревью 2026-09-09 (ось «безопасность и PII»).
 */
function scrubBotToken(url: string): string {
  return url.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[REDACTED]');
}

/**
 * Тот же денилист для строки запроса внутри полного URL — плюс токен в пути и
 * ФРАГМЕНТ целиком.
 *
 * ⚠️ Фрагмент — не косметика. Telegram открывает Mini App адресом
 * `…/cabinet#tgWebAppData=<initData>`: подписанная initData живёт 24 часа и
 * даёт `card-details`, то есть номер и CVC карты клиента. Браузерный SDK кладёт
 * `location.href` вместе с фрагментом в `request.url` каждого события и
 * pageload-транзакции, а навигационные крошки — в `from`/`to`; денилист строки
 * запроса фрагмент не видел вовсе (ревью 2026-09-25, ось C). Разбирать фрагмент
 * по параметрам незачем — для отладки он не нужен, поэтому закрывается целиком.
 */
function scrubUrl(url: string): string {
  const withoutToken = scrubBotToken(url);
  const hashAt = withoutToken.indexOf('#');
  const base = hashAt === -1 ? withoutToken : withoutToken.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : '#[REDACTED]';
  const cut = base.indexOf('?');
  if (cut === -1) return `${base}${fragment}`;
  return `${base.slice(0, cut)}?${scrubQueryString(base.slice(cut + 1))}${fragment}`;
}

export type SentryEvent = SentryTypes.ErrorEvent;
export type SentryHint = SentryTypes.EventHint;

/**
 * Ошибки ЧУЖОЙ среды исполнения, а не наши.
 *
 * ⚠️ Список закрытый и обязан таким остаться: каждая строка — конкретный текст,
 * доказанный живой проверкой, что в нормальном браузере его нет. Глушить класс
 * ошибок целиком (например, все `TypeError`) нельзя — так исчезнут наши
 * настоящие падения.
 *
 * `Cannot assign to read only property 'push'` — Next при загрузке
 * переопределяет `push` у массива RSC-payload (`self.__next_f.push = …`).
 * Сканеры и анти-бот-обвязки замораживают глобальные объекты перед исполнением
 * страницы, и присваивание падает у них. Домен панели попал в
 * Certificate Transparency сразу после выпуска сертификата, и первый же такой
 * клиент дал 158 событий за час — issue уехал в escalating и начал жечь и
 * квоту, и внимание дежурного (2026-08-19).
 */
const FOREIGN_RUNTIME_ERRORS = [
  "Cannot assign to read only property 'push'",
  /*
   * `Error invoking postMessage: Java object is gone` — сообщение Android
   * WebView, а не нашего кода. Внутри WebView страница общается с нативной
   * частью через проброшенный Java-объект; когда WebView уничтожается (человек
   * закрыл окно, свернул приложение, нажал «назад»), объект освобождается, а
   * инжектированный скрипт продолжает слать в мост `postMessage`.
   *
   * У нас мост инжектит сам встроенный браузер: Telegram на Android открывает
   * внешние ссылки во внутреннем WebView с `TelegramWebviewProxy`, так же
   * поступают in-app браузеры VK и Instagram. Что это чужое, видно по адресу
   * события — `/`, то есть главная сайта, где SDK Telegram не грузится вовсе
   * (`components/cabinet/telegram.ts` подключает его только в кабинете).
   *
   * Клиент от этого не страдает: ошибка возникает в момент, когда он уже
   * уходит со страницы. А вот алёрт по ней — фон, который приучает не читать
   * алёрты (2026-09-09).
   */
  'Java object is gone',
] as const;

function isForeignRuntimeError(event: SentryEvent): boolean {
  const values = event.exception?.values ?? [];
  return values.some((v) =>
    FOREIGN_RUNTIME_ERRORS.some((needle) => (v.value ?? '').includes(needle)),
  );
}

export function beforeSend(event: SentryEvent): SentryEvent | null {
  // Отбрасываем ДО скраббера: чистить PII в событии, которое всё равно не
  // поедет, незачем.
  if (isForeignRuntimeError(event)) return null;

  scrubEventEnvelope(event);
  return event;
}

/**
 * Чистка «обёртки» события: запрос, крошки, contexts/extra/tags, свободный
 * текст. Вынесена отдельно, потому что нужна ДВУМ хукам — ошибкам и
 * транзакциям.
 *
 * ⚠️ Транзакции идут МИМО `beforeSend`, и без этого вызова хук транзакций
 * закрывал бы один канал из четырёх: `requestDataIntegration` кладёт в них тот
 * же `request` с разобранной cookie сессии панели и строкой поиска `?q=`, а
 * сэмплируется на проде каждая десятая (находка ревью 2026-09-09).
 */
function scrubEventEnvelope(event: {
  request?: SentryEvent['request'];
  breadcrumbs?: SentryEvent['breadcrumbs'];
  extra?: SentryEvent['extra'];
  contexts?: SentryEvent['contexts'];
  tags?: SentryEvent['tags'];
  message?: SentryEvent['message'];
  exception?: SentryEvent['exception'];
}): void {
  // Request body / query / headers — денилист PII
  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubRequestBody(event.request.data) as typeof event.request.data;
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
        // PAN+CVC чужой карты. `/api/cabinet` возит её в ТЕЛЕ, а `/api/analytics`
        // — заголовком, поэтому без этого имени в списке она уезжала бы в
        // Sentry целиком (найдено ревью 2026-07-30). Тело на сервере не
        // перехватывается вовсе (`sentry.server.config.ts`), а если приедет —
        // `scrubRequestBody` разберёт JSON и вычистит `initData` по ключу.
        // До 2026-09-25 тело приезжало СТРОКОЙ, и денилист `init_?data` её не
        // видел: обещание в этом комментарии было неправдой (тикет 06).
        //
        // Заголовки с IP клиента (`x-forwarded-for` от Traefik и родня) —
        // тоже: IP для нас персональные данные (`last_seen_ip` вычищается по
        // имени ключа), политика конфиденциальности обещает, что в журналы
        // ошибок он не уходит, а requestData прикладывала заголовки к каждому
        // серверному событию целиком (сверка документов с кодом 2026-09-24).
        if (
          /authorization|cookie|x-telegram-bot-api-secret-token|x-alert-token|x-telegram-init-data|x-forwarded-for|x-real-ip|^forwarded$|x-client-ip|cf-connecting-ip|true-client-ip/i.test(
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
        // Полный денилист, а не один `Bearer`: console-крошки Node SDK включены
        // по умолчанию, и туда попадает и адрес Bot API с токеном, и
        // PAN-подобная последовательность из ответа провайдера.
        crumb.message = scrubText(crumb.message);
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
}

/**
 * Транзакции идут МИМО `beforeSend` — у них свой хук. Без него спан исходящего
 * запроса к Bot API увозил бы адрес с токеном в путь трассировки: на проде
 * сэмплируется каждая десятая транзакция, то есть это вопрос времени, а не
 * случая. Чистим ровно то, что несёт адрес: имя транзакции и атрибуты спанов.
 */
export function beforeSendTransaction<T extends { transaction?: string; spans?: unknown[] }>(
  event: T,
): T {
  // Та же чистка, что у ошибок: транзакция несёт `request` (cookie сессии
  // панели, `?q=` с контактом клиента), крошки и contexts.
  scrubEventEnvelope(event as Parameters<typeof scrubEventEnvelope>[0]);

  if (typeof event.transaction === 'string') {
    // `as` — плата за generic-сигнатуру: тип `TransactionEvent` в
    // `@sentry/nextjs` не реэкспортируется, а тянуть его из `@sentry/core`
    // значит прописать транзитивную зависимость. Значение здесь заведомо
    // строка (проверено строкой выше).
    event.transaction = scrubUrl(event.transaction) as T['transaction'];
  }
  // Атрибуты КОРНЕВОГО спана живут в `contexts.trace.data`, а не в `spans`:
  // адрес pageload-транзакции (`url.full` с фрагментом initData Mini App)
  // иначе прошёл бы мимо — чистка `contexts` выше смотрит только на ключи.
  const traceData = (event as { contexts?: { trace?: { data?: unknown } } }).contexts?.trace?.data;
  if (typeof traceData === 'object' && traceData !== null) {
    const bag = traceData as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const value = bag[key];
      if (typeof value === 'string') bag[key] = scrubUrl(value);
    }
  }
  if (!Array.isArray(event.spans)) return event;
  for (const span of event.spans) {
    if (typeof span !== 'object' || span === null) continue;
    const record = span as Record<string, unknown>;
    if (typeof record.description === 'string') record.description = scrubUrl(record.description);
    const attrs = record.data;
    if (typeof attrs !== 'object' || attrs === null) continue;
    // ⚠️ Прогоняем КАЖДОЕ строковое значение, а не только похожее на адрес Bot
    // API: у спана входящего запроса в атрибутах лежит `http.query` и
    // `url.full` — то есть поиск по email клиента из формы панели.
    record.data = scrubPii(attrs) as Record<string, unknown>;
    const bag = record.data as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const value = bag[key];
      if (typeof value === 'string') bag[key] = scrubUrl(value);
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
  beforeSendTransaction,
} as const;
