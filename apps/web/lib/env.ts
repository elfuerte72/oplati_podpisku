import { z } from 'zod';

/**
 * Env-валидация через Zod.
 *
 * - `serverEnv` — server-only переменные (секреты, DATABASE_URL, service_role).
 *   Использовать ТОЛЬКО из server-кода. При попытке импорта на клиенте сработает `import 'server-only'`.
 * - Объект — **lazy** (геттер): парсинг идёт при первом обращении, а не на этапе
 *   импорта. Это спасает `next build` в CI/CD, когда `.env.local` отсутствует
 *   и build попадает на import-time evaluation.
 * - На старте приложения (`instrumentation.ts`) делаем явный `serverEnv` touch,
 *   чтобы падение было fail-fast, а не при первом запросе.
 *
 * Sprint-1 опциональные: Telegram/Upstash — помечены `.optional()`.
 */

/**
 * Base URL API Love&Pay по умолчанию.
 *
 * ⚠️ Суффикс `/api/v2` — ОБЯЗАТЕЛЬНАЯ часть значения, а не украшение: клиент берёт
 * `pathname` из этого URL и подписывает им HMAC (`signPath` в `lib/loveandpay/client.ts`).
 *
 * Письмо провайдера от 2026-07-29 называет новым base URL голый
 * `https://api.prod.loveandpay.io` — записать его буквально нельзя. Живая проба с
 * прод-VPS: `POST /api/v2/invoices` → `401 MISSING_HEADERS` (путь верный, ждёт
 * заголовки), `POST /invoices` → `404 Not found`. То есть хост сменился, а префикс
 * версии сохранён. Старый `https://loveandpay.io/api/v2` провайдер гасит после
 * 2026-08-01.
 */
export const LOVEANDPAY_DEFAULT_BASE_URL = 'https://api.prod.loveandpay.io/api/v2';

// -------------------------------------------------------------------------
// Хелперы для опциональных env-переменных
// -------------------------------------------------------------------------
//
// Проблема: в `.env.local` часто оставляют переменные как `KEY=` (пустая строка) —
// это значит «ещё не заполнил». Но Zod `.optional()` интерпретирует только `undefined`
// как «отсутствует»; пустая строка — это валидная строка, и она проваливает `.min(1)`
// или `.url()`. Итог: fail-fast срабатывает там, где не должен.
//
// Решение: preprocess `"" → undefined` перед валидацией. Тогда `.optional()` работает
// так, как ожидается. Подробности — см. patch 2026-04-22-23.xx.md.
//
// Этот хелпер — единственный правильный способ объявить опциональный env-string в проекте.
//
// ⚠️ Само правило «пустая строка = не задано» с 2026-08-10 применяется ГЛОБАЛЬНО,
// один раз для всего объекта (`withoutEmptyValues` ниже) — хелпер закрывал только
// строковые переменные, а числовые и enum'ы с дефолтом оставались дырявыми.
// Новую env-переменную объявлять по обычным правилам Zod: пустую строку она уже
// не увидит. Per-field preprocess'ы оставлены как есть — они безвредны и делают
// схему самодостаточной, если её когда-нибудь применят к другому источнику.

function optionalEnvString(inner: z.ZodTypeAny = z.string().min(1)): z.ZodType {
  return z.preprocess((v) => (v === '' ? undefined : v), inner.optional());
}

/**
 * `KEY=` (пустая строка) — это «ещё не заполнил», а не значение. Отсекаем такие
 * ключи ДО схемы, один раз для всего объекта: `optionalEnvString` закрывал
 * только строковые переменные, а числовые и enum'ы с дефолтом оставались
 * дырявыми (аудит 2026-08-10).
 *
 * Дыра была денежной: `z.coerce.number()` превращает `''` в **0**, а
 * `.default()` срабатывает только на `undefined`. То есть `COMMISSION_PERCENT=`
 * означало работу с нулевой наценкой, а `FREEKASSA_MAX_AMOUNT_RUB=` — снятый
 * потолок суммы платежа. Ни валидация, ни логи об этом не сообщали. Правка env
 * через API Dokploy перезаписывает его ЦЕЛИКОМ, поэтому опечатка именно такого
 * вида и вероятна.
 *
 * Поведение переменных, у которых пустая строка что-то значила бы, не меняется:
 * булевы флаги читаются как `v === '1' || v === 'true'` (пустая строка и так
 * давала `false`, теперь даёт дефолт `false`), а строковые уже проходили через
 * `optionalEnvString`.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== '') cleaned[key] = value;
  }
  return cleaned;
}

const optionalUrl = () => optionalEnvString(z.string().url());

/**
 * Адрес указывает «на самих себя»? Пускаем loopback и бездоменные имена — так
 * выглядит имя сервиса внутри docker-сети (`oplatishka-web`, `localhost`).
 * Публичный FQDN или внешний IP — нет.
 *
 * Нужно для `SELF_BASE_URL`: он приоритетнее всех прочих баз, а self-call несёт
 * `X-Internal-Token`, поэтому ошибочное значение — это утечка внутреннего
 * токена наружу плюс счёт, созданный в чужом стеке (B-4).
 */
function isSelfAddressableUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return false;
  }
  // URL оборачивает IPv6 в скобки: `http://[::1]:3000` → hostname `[::1]`.
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '::1') return true;
  // Вся сеть 127.0.0.0/8, а не только 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  // Имя сервиса в docker-сети: без точек и без двоеточий.
  return !bare.includes('.') && !bare.includes(':');
}

// -------------------------------------------------------------------------
// Схемы
// -------------------------------------------------------------------------

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // App
  APP_URL: z.string().url(),

  // База для Mini App-кабинета (web_app-кнопка в /start). Кабинет открывается
  // ТОЛЬКО из Telegram, где у пользователя РФ уже есть VPN → *.vercel.app
  // доступен напрямую. Ведём кабинет мимо reverse-proxy (Timeweb) прямо на
  // Vercel: меньше latency (нет лишнего хопа РФ→Vercel) и нет зависимости
  // кабинета от прокси. Сайт (siteUrl) остаётся на APP_URL за прокси — он для
  // РФ БЕЗ VPN. Не задан → fallback на APP_URL (кабинет через прокси, как было).
  MINIAPP_BASE_URL: optionalUrl(),

  // Supabase — legacy-обвязка managed-хостинга: в рантайме НЕ используется
  // (SDK @supabase/supabase-js в коде нет, весь доступ к БД — postgres-js по
  // DATABASE_URL; единственное упоминание — redact-лист логгера). Переведены в
  // optional при переезде на self-host Postgres (docs/dokploy-migration-plan.md):
  // Vercel-прод их по-прежнему задаёт (безвредно), Dokploy-контур — нет.
  SUPABASE_URL: optionalUrl(),
  SUPABASE_ANON_KEY: optionalEnvString(),
  SUPABASE_SERVICE_ROLE_KEY: optionalEnvString(),
  DATABASE_URL: optionalUrl(),
  DATABASE_URL_DIRECT: optionalUrl(),

  // AI (Sprint 1.5 — Telegram + AI v1; на Sprint 1 ещё не используется)
  ANTHROPIC_API_KEY: optionalEnvString(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // Для финансовой коммуникации стабильнее низкая температура; max_tokens
  // увеличен на 2048 (хватает на KYC-инструкции, длинные ссылки и пр.).
  ANTHROPIC_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.3),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().min(256).max(8192).default(2048),
  // Haiku-роутер перед основным агентом (packages/agent/src/router.ts).
  // Модель читается агентом напрямую из process.env (как ANTHROPIC_MODEL).
  ANTHROPIC_ROUTER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Аварийный выключатель роутера: '1'/'true' — все сообщения идут сразу в агент.
  AI_ROUTER_DISABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),
  // Дневной глобальный бюджет AI во «взвешенных» токенах (эквивалент input-цены
  // Sonnet; веса и формула — apps/web/lib/ai/budget.ts). 3M ≈ $9/день.
  AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(3_000_000),

  // Telegram (Sprint 1.5)
  TELEGRAM_BOT_TOKEN: optionalEnvString(),
  TELEGRAM_WEBHOOK_SECRET: optionalEnvString(),
  // Куда бот пересылает обращения из /support (interim-handoff, пока нет
  // forum-topics). ЕДИНСТВЕННЫЙ источник получателя (M-15: дефолт из кода
  // удалён 2026-07-19); не задан → обращения не доставляются + Sentry. Оператор
  // ОБЯЗАН один раз запустить бота (/start), иначе Telegram не даст слать ему DM.
  // Формат — числовой chat_id (может быть отрицательным для групп) или @username;
  // мусорное значение fail-fast на старте, а не молчаливым сбоем sendMessage.
  SUPPORT_OPERATOR_CHAT_ID: optionalEnvString(
    z.string().regex(/^(-?\d+|@[A-Za-z0-9_]{4,})$/, 'must be a numeric chat id or @username'),
  ),
  // Short name зарегистрированного в BotFather Mini App (/newapp) — на проде
  // `oplatishkaMiniApp`. Задан → кнопка «Личный кабинет» на сайте ведёт прямой
  // ссылкой `telegram.me/<bot>/<shortname>` (кабинет открывается одним тапом). Не задан
  // → fallback `telegram.me/<bot>?start=cabinet`: бот покажет /start-меню с web_app-
  // кнопкой (лишний тап, но работает всегда — например у preview-бота, где
  // приложение не зарегистрировано).
  TELEGRAM_MINIAPP_SHORTNAME: optionalEnvString(
    z.string().regex(/^[A-Za-z0-9_]{3,64}$/, 'must be a Telegram app short name'),
  ),
  // Формат реф-ссылки приглашения. По умолчанию ВЫКЛЮЧЕНО (решение владельца
  // 2026-07-02 в пользу bot-контекста): ссылка — `telegram.me/<bot>?start=ref_<code>`,
  // друг сначала видит бота и приветствие. '1'/'true' + заданный
  // TELEGRAM_MINIAPP_SHORTNAME → прямая ссылка на приложение
  // `telegram.me/<bot>/<shortname>?startapp=ref_<code>` (реф-код доезжает в
  // initData.start_param). Отдельный флаг, чтобы short name можно было задать
  // ради кнопки «Личный кабинет», не меняя поведение реф-ссылки.
  REFERRAL_MINIAPP_DEEPLINK: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

  // ─── Админ-панель (`/admin`) ─────────────────────────────────────────────
  //
  // Вход — Telegram Login Widget (первый фактор) + TOTP (второй). Паролей нет.
  // Бот входа ОТДЕЛЬНЫЙ от клиентского (`@oplatishkaasupport_bot`): утечка
  // клиентского токена не должна отдавать первый фактор входа персонала, а
  // alert-бот остаётся на авариях инфраструктуры.
  //
  // ⚠️ Имя бота говорит «support», но это бот ПЕРСОНАЛА: он же доставляет
  // уведомления менеджеру. Клиентская поддержка живёт в `@oplatishkaa_bot`.
  //
  // Не заданы → панель отвечает «вход не настроен» и никого не пускает. Это
  // осознанный fail-closed: панель видит заказы, клиентов и деньги.
  TELEGRAM_LOGIN_BOT_TOKEN: optionalEnvString(),
  // Нужен виджету на странице входа (атрибут `data-telegram-login`).
  TELEGRAM_LOGIN_BOT_USERNAME: optionalEnvString(
    z.string().regex(/^[A-Za-z0-9_]{4,64}$/, 'must be a Telegram bot username without @'),
  ),
  // Свой секрет вебхука бота персонала — НЕ общий с клиентским ботом: общий
  // означал бы, что компрометация одного открывает точку приёма другого.
  TELEGRAM_LOGIN_BOT_WEBHOOK_SECRET: optionalEnvString(),
  // Подпись cookie сессии панели. Минимум 32 символа: короткий секрет здесь —
  // это подделка сессии перебором, а сессия панели видит всё.
  ADMIN_SESSION_SECRET: optionalEnvString(
    z.string().min(32, 'must be at least 32 characters'),
  ),
  // Хост, на котором живёт панель (`admin.oplatishka.com`). Задан — `/admin` и
  // `/api/panel` на любом другом хосте отдают 404. Это ЗАЩИТА В ГЛУБИНУ поверх
  // маршрутизации Traefik, а не замена ей: ошибка в конфиге прокси не должна
  // означать открытую панель. Не задан → гейт по хосту выключен (локальная
  // разработка, где хост `localhost:3000`).
  PANEL_HOST: optionalEnvString(),

  // Love & Pay (MVP) — RUB-acquiring; preview = pk_test_*, prod = pk_live_*
  LOVEANDPAY_API_KEY: optionalEnvString(),
  LOVEANDPAY_SECRET_KEY: optionalEnvString(),
  LOVEANDPAY_WEBHOOK_SECRET: optionalEnvString(),
  LOVEANDPAY_BASE_URL: z.string().url().default(LOVEANDPAY_DEFAULT_BASE_URL),
  // Исходящий CONNECT-прокси для запросов к L&P (верификация доступа по IP, 2026-07-15:
  // L&P принимает запросы только с задекларированных IP; у Vercel egress динамический).
  // Формат: http://user:pass@host:port (VPS с фиксированным IP). TLS идёт насквозь —
  // прокси не видит API-ключи. Не задан → прямое соединение.
  LOVEANDPAY_PROXY_URL: optionalUrl(),
  // Минимальная сумма счёта L&P в рублях (терминал KANYON не принимает < 500 ₽).
  // Ниже лимита `/api/payments/create` вернёт below_min_amount ДО вызова L&P,
  // чтобы не ловить INTERNAL_ERROR на стороне провайдера.
  LOVEANDPAY_MIN_AMOUNT_RUB: z.coerce.number().int().min(500).default(500),

  // ─── Freekassa — второй шлюз приёма рублей ───────────────────────────────
  // Интеграция строго через API (не SCI-форма), решение владельца 2026-07-26.
  // ⚠️ `FREEKASSA_SECRET_WORD_1` намеренно ОТСУТСТВУЕТ в схеме: оно подписывает
  // только SCI-форму, которую мы не используем. В env прода оно лежит про запас
  // (переход на SCI не потребовал бы беготни по кабинету), но кодом не читается —
  // объявление его здесь создавало бы ложное впечатление, что читается.
  FREEKASSA_API_KEY: optionalEnvString(),
  // Секретное слово 2 — проверка подписи ВХОДЯЩЕГО уведомления (MD5).
  FREEKASSA_SECRET_WORD_2: optionalEnvString(),
  // ID магазина; обязателен в каждом запросе к API. Приходит числом.
  FREEKASSA_SHOP_ID: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  FREEKASSA_BASE_URL: z.string().url().default('https://api.fk.life/v1'),
  // Способ оплаты по умолчанию (`i`): 44 — СБП, 36 — карты РФ. Выбор способа
  // клиентом означал бы новый элемент UI сразу в трёх местах (веб, Mini App,
  // бот) — пока шлём один и тот же (открытый вопрос §7 ТЗ).
  FREEKASSA_METHOD_ID: z.coerce.number().int().positive().default(44),
  // Значение поля `ip` (IP ПЛАТЕЛЬЩИКА) в запросе `/orders/create`, когда
  // реальный неизвестен: счёт выставляет сервер внутренним self-call'ом, а у
  // заказов из бота и Mini App клиентского IP нет в принципе. `127.0.0.1`
  // провайдер блокирует, поэтому шлём публичный IP нашего VPS.
  // ⚠️ Это НЕ запасной платёжный шлюз — тот за `PAYMENT_AUTO_FALLBACK`.
  FREEKASSA_FALLBACK_IP: optionalEnvString(z.string().ip()).pipe(
    z.string().default('187.124.172.104'),
  ),
  // Сколько живёт счёт Freekassa. Провайдер срок жизни заказа НЕ отдаёт (в
  // ответе `/orders/create` его нет) — это НАШ срок ожидания оплаты, по нему
  // выравнивается `orders.expires_at`. Умышленно отдельная переменная, а не
  // переиспользование `INVOICE_TTL_HOURS` L&P: у провайдеров срок разный, и
  // копирование вслепую даёт либо преждевременное захоронение оплаченного
  // заказа, либо протухший курс. Уточнить у провайдера при смоуке.
  FREEKASSA_INVOICE_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(1),
  // Минимальная сумма счёта в рублях. Дефолт 500 — решение владельца
  // 2026-07-26: тот же порог, что у L&P. Своего минимума провайдер не
  // публиковал, но одинаковый порог у обоих шлюзов означает, что переключение
  // не меняет, какие заказы вообще можно оформить, и совпадает с полом витрины
  // (`lib/catalog/build.ts` прячет тарифы дешевле `LOVEANDPAY_MIN_AMOUNT_RUB`).
  // 0 — аварийный выключатель гейта, если провайдер окажется терпимее.
  // ⚠️ Поднимать выше 500 нельзя без синхронного подъёма пола витрины: иначе
  // клиент оформит заказ, который `payments/create` отвергнет как
  // below_min_amount уже после выбора тарифа.
  FREEKASSA_MIN_AMOUNT_RUB: z.coerce.number().int().nonnegative().default(500),
  // Максимальная сумма счёта в рублях. Лимит операции у провайдера — 150 000 ₽
  // и по СБП (`i=44`), и по картам РФ (`i=36`); снято из кабинета 2026-07-28.
  // Дефолт 140 000 — запас на комиссию покупателя (6% СБП / 7% карты
  // накручиваются на нашу сумму уже на стороне провайдера, и неизвестно,
  // считается лимит до или после неё). 0 — выключатель гейта.
  // У L&P потолка нет (`maxAmountRubFor` вернёт 0), поэтому переключение шлюза
  // меняет и максимум оформляемого заказа — верхний кап витрины держится в
  // `HIGH_VALUE_MAX_AMOUNT_USD` и рассчитан на этот лимит.
  FREEKASSA_MAX_AMOUNT_RUB: z.coerce.number().int().nonnegative().default(140_000),
  // Антифрод-трек (тикет 05): порог суммы заказа в ЦЕЛЫХ рублях, от которого
  // обязателен телефон плательщика. НЕ задан → фича выключена (безопасный
  // rollout; прод-значение 10000). Сравнение с orders.amount_rub (копейки) —
  // конверсия строго в одном месте (payments/create). В UI-тексты порог не
  // зашивается: сервер отдаёт его в теле ответа/конфиге (инвариант 10).
  PHONE_REQUIRED_FROM_RUB: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // Слать ли телефон плательщика в `tel` запроса /orders/create (тикет 07).
  // Дефолт ВЫКЛ: параметр в доке провайдера не описан, а правило проекта —
  // не выдумывать контракт. Включать ТОЛЬКО после живого вызова: счёт с `tel`
  // реально создаётся и оплачивается (см. открытые вопросы спеки, Немо).
  FREEKASSA_SEND_TEL: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
  // Комиссия, которую провайдер накручивает ПЛАТЕЛЬЩИКУ поверх нашего счёта
  // (ползунок «Магазин ↔ Покупатель» в кабинете; 2026-07-28 выкручен на
  // покупателя: 6% СБП / 7% карты). Мы её не считаем и не берём — только
  // ПОКАЗЫВАЕМ, чтобы сумма на странице провайдера не была сюрпризом.
  // ⚠️ Значение обязано совпадать с ползунком в кабинете: разъедутся — клиенту
  // будем обещать не ту цифру. 0 → тексты о комиссии не показываются вовсе.
  FREEKASSA_BUYER_FEE_PERCENT: z.coerce.number().min(0).max(50).default(6),
  // Allowlist отправителей уведомления, через запятую. НЕ задан → используем
  // список из доки, но несовпадение только алёртим (подпись MD5 остаётся
  // единственным жёстким гейтом). Задан → несовпадение отвергает уведомление.
  // Разделение сделано намеренно: провайдер может сменить адреса молча, и
  // жёсткий allowlist по умолчанию положил бы приём денег без единого симптома,
  // кроме тишины.
  FREEKASSA_ALLOWED_IPS: optionalEnvString(),

  // Кто принимает рубли ПРЯМО СЕЙЧАС. Меняется значением env + перезапуском
  // контейнера, без правок кода и релиза. Влияет ТОЛЬКО на создание нового
  // счёта (`/api/payments/create`); вебхуки ОБОИХ провайдеров работают всегда —
  // в момент переключения у части клиентов уже выставлены счета прежнего
  // шлюза, и закрытый вебхук означал бы «деньги списаны, заказ не оплачен».
  // Дефолт `loveandpay` намеренно: он проверен живыми деньгами, Freekassa —
  // ещё ни одним платежом. Потеря env возвращает контур в известное рабочее
  // состояние, а не в неопробованное.
  PAYMENT_PRIMARY_PROVIDER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['loveandpay', 'freekassa']).default('loveandpay'),
  ),

  // Автоматический фоллбэк на ВТОРОЙ шлюз, когда основной не отвечает
  // (таймаут / сетевой сбой / 5xx после ретраев). Без него клиент в этот момент
  // видит «технический сбой, попробуй позже» — а «позже» не помогает, если шлюз
  // лёг всерьёз.
  //
  // ⚠️ Это НЕ замена ручному переключателю. Детектор ловит только транспорт;
  // самый частый реальный отказ — «шлюз отвечает 200, ссылку выдаёт, а платежи
  // у клиентов не проходят» — для кода выглядит успехом, и фоллбэк не сработает.
  // Дефолт ВЫКЛЮЧЕНО: включать после того, как ОБА шлюза проверены живыми
  // деньгами — иначе сбой основного увёл бы поток на непроверенный контур.
  PAYMENT_AUTO_FALLBACK: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

  // app.pay.space (MVP) — выпуск виртуальных USD-карт
  PAYSPACE_API_KEY: optionalEnvString(),
  // HMAC-секрет подписи исходящих запросов (X-Signature). Задан в кабинете → подпись
  // обязательна для всех запросов.
  PAYSPACE_REQUEST_SECRET: optionalEnvString(),
  // Секрет проверки подписи входящих VCC-вебхуков (Шаг E; схема подписи D6).
  PAYSPACE_WEBHOOK_SECRET: optionalEnvString(),
  PAYSPACE_BASE_URL: z.string().url().default('https://app.pay.space/api/v1'),
  // Порог алёрта по балансу VCC-аккаунта (USD-центы). `0` — считать порог
  // ОТНОСИТЕЛЬНО самого дорогого заказа каталога (цена + буфер + fee за выпуск):
  // плоское число не отвечает на вопрос «хватит ли на следующий заказ», из-за
  // чего 14 августа остаток $89.50 «был выше порога $50», а заказу на $100
  // карты не досталось. Выключение — отдельным флагом ниже, не нулём.
  PAYSPACE_MIN_VCC_BALANCE_USD_CENTS: z.coerce.number().int().nonnegative().default(0),
  // Явное «алёрт баланса выключен, мы знаем». Заведён потому, что прошлое
  // выключение сделали нулём в пороге — и оно выглядело как «настроено»
  // (docs/BACKLOG.md, риск сработал 2026-08-14).
  VCC_BALANCE_ALERT_DISABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),
  // Буфер сверх USD-цены сервиса на сумму ВЫПУСКАЕМОЙ/пополняемой карты (проценты).
  // По умолчанию 0: карты американские, мерчантов оплачиваем в USD без НДС и FX
  // (клиента просим включить VPN США и вводить цену без налога), поэтому реальный
  // charge = витринная цена, запас не нужен. Закладывается ТОЛЬКО в сумму карты,
  // в цену клиенту НЕ входит. >0 ставить, если по реальным заказам charge окажется
  // выше цены (FX/VAT) — тогда неизрасходованный остаток вернётся на VCC при release.
  PAYSPACE_CARD_BUFFER_PERCENT: z.coerce.number().int().min(0).max(100).default(0),

  // Remnawave (VPN Оплатишки) — панель управления VPN-подписками. Кнопка «VPN»
  // в боте выдаёт ссылку-подписку (создаёт юзера панели по telegramId).
  // Токен — ОТДЕЛЬНЫЙ API-токен для бэкенда (роль API, не мастер-токен
  // владельца), живёт только в env. Не задан → кнопка отвечает «недоступно».
  REMNAWAVE_API_TOKEN: optionalEnvString(),
  // Только https: Bearer-токен уходит в заголовке каждого запроса.
  REMNAWAVE_BASE_URL: z
    .string()
    .url()
    .startsWith('https://')
    .default('https://panel.mxpkn8ns.ru/api'),
  // Внутренний squad по умолчанию (Default-Squad): даёт юзеру ОБА подключения
  // (Lithuania + «При белых списках»); без сквада подписка пустая.
  REMNAWAVE_SQUAD_UUID: z
    .string()
    .uuid()
    .default('e819a231-6e10-46c6-8411-7001dd67e9e1'),
  // Лимит трафика подписки в ГБ на пользователя (сброс счётчика раз в месяц,
  // strategy MONTH); 0 = безлимит. Дефолт 200 ГБ (решение владельца 2026-07-21).
  // Кап 100k ГБ — чтобы перевод в байты (×1024³) не вышел за safe integer.
  REMNAWAVE_TRAFFIC_LIMIT_GB: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(100_000)
    .default(200),
  // Срок подписки в календарных месяцах; 0 = БЕЗ ОГРАНИЧЕНИЯ (дефолт, решение
  // владельца 2026-07-29: VPN бесплатный, месячный срок давал только мёртвую
  // ссылку у клиента). Ненулевое значение возвращает срочные подписки — тогда
  // же снова понадобится продление по оплате. Кап 120 месяцев: дальше начинается
  // сентинел безлимита, и «срочная» подписка стала бы неотличима от бессрочной.
  REMNAWAVE_SUBSCRIPTION_MONTHS: z.coerce.number().int().nonnegative().max(120).default(0),

  // Снапшот комиссии (10 = 10%); дефолт совпадает с константой в propose-order
  COMMISSION_PERCENT: z.coerce.number().int().min(0).max(50).default(10),

  // Разовая надбавка за выпуск виртуальной карты (USD-центы), которую платит
  // клиент ТОЛЬКО при первой оплате — когда активной карты ещё нет и PaySpace
  // спишет $4 issue-fee на createCard. При повторной оплате с уже выпущенной
  // картой (топап, без issue-fee) надбавки нет. Конвертируется в рубли по курсу
  // заказа и добавляется к amount_rub (снимок — orders.card_issue_fee_kopecks).
  // Дефолт 0 — надбавку не берём (безопасно); на проде задать 400 ($4).
  CARD_ISSUE_FEE_USD_CENTS: z.coerce.number().int().nonnegative().default(0),

  // Реферальная (партнёрская) программа. Глобальный kill-switch: '1'/'true' —
  // захват реферера и начисления включены; по умолчанию ВЫКЛЮЧЕНО (фаза катится
  // поэтапно, см. plan.md). REFERRAL_MIN_PAYOUT_USD_CENTS — минимум на вывод
  // ($10 = 1000 центов), Этап D/E.
  REFERRAL_ENABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),
  REFERRAL_MIN_PAYOUT_USD_CENTS: z.coerce.number().int().positive().default(1000),

  // Взаимодействие с Оплатишкой (AI-диалог + кнопочный каталог /menu) в ЧАТЕ бота.
  // Выключено по умолчанию (2026-07-03): бот-чат отвечает только на команды и
  // кнопки, а покупки/диалог уводятся в Mini App. '1'/'true' возвращает прежнее
  // поведение (AI-агент + /menu-каталог прямо в чате). Код обоих путей сохранён —
  // это временный выключатель, а не удаление функциональности.
  BOT_AI_ENABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

  // AI-диалог в ВЕБ-чате сайта (/api/chat). Выключено по умолчанию (решение
  // владельца 2026-07-19): покупка кнопочная, диалог в воронке не участвует —
  // на любое сообщение уходит мгновенная заготовка без вызова Anthropic и
  // записей в БД (UI сайта не меняется). '1'/'true' возвращает AI-диалог.
  // Код агента цел — это временный выключатель по образцу BOT_AI_ENABLED.
  WEB_AI_ENABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

  // Fallback USDT→RUB курс, если публичный endpoint Rapira временно недоступен.
  // Значение — рубли за 1 USDT; живой `askPrice` Rapira имеет приоритет.
  // 81 — решение владельца 2026-07-19 (M-14: прежний дефолт 77 занижал цену
  // при сбое Rapira и съедал маржу); при дрейфе рынка обновлять env/дефолт.
  RATE_FALLBACK_USDT_RUB: z.coerce.number().positive().default(81),

  // Внутренний токен для self-call'ов из tool-handler в /api/payments/create
  INTERNAL_API_TOKEN: optionalEnvString(),

  // База self-call'а confirm_order → /api/payments/create (self-host/Dokploy):
  // в контейнере задаётся `http://127.0.0.1:3000` — денежный вызов идёт внутрь
  // собственного процесса, не выходя в интернет и не завися от Traefik/DNS.
  // Не задан → прежняя цепочка VERCEL_URL → APP_URL (Vercel не затронут).
  //
  // ⚠️ Значение обязано указывать «на себя», и это проверяется (B-4). Переменная
  // приоритетнее всего остального, а self-call несёт `X-Internal-Token` —
  // опечатка во внешний хост отправила бы туда наш внутренний токен и создала
  // счёт в чужом стеке. Пускаем только loopback и бездоменное имя (имя сервиса
  // в docker-сети вроде `oplatishka-web`); публичный FQDN или внешний IP —
  // ошибка старта, а не тихая утечка.
  SELF_BASE_URL: optionalUrl().refine(
    (v) => v === undefined || v === '' || isSelfAddressableUrl(v),
    {
      message:
        'SELF_BASE_URL должен указывать на сам сервис: loopback (http://127.0.0.1:3000) ' +
        'или имя сервиса в docker-сети без точек. Внешний хост запрещён — self-call несёт X-Internal-Token.',
    },
  ),

  // Секрет cron-endpoint'ов. Vercel Cron шлёт его как `Authorization: Bearer`.
  // Без него `authorizeCron` пускает только NODE_ENV=development (fail-closed
  // на preview/production). На проде задавать ОБЯЗАТЕЛЬНО.
  CRON_SECRET: optionalEnvString(),
  CRON_TOKEN: optionalEnvString(),

  // Алерты Sentry → Telegram (relay POST /api/alerts/sentry). Sentry alert rule
  // шлёт webhook с секретом в query (?s=<...>), endpoint пересылает алёрт в
  // Telegram через бота. SENTRY_ALERT_WEBHOOK_SECRET гейтит запрос (timing-safe);
  // ALERT_TELEGRAM_CHAT_ID — куда слать (telegram_id владельца или id группы
  // алёртов, где бот). Любой не задан → endpoint no-op (200).
  SENTRY_ALERT_WEBHOOK_SECRET: optionalEnvString(),
  ALERT_TELEGRAM_CHAT_ID: optionalEnvString(),

  // Отдельный alert-бот — канал ВСЕХ операционных алёртов (notifyOps:
  // proxy-health/недоплаты; Sentry-relay). Изолирован от прод-бота (клиенты) и
  // dev-бота (тестирование фич перед PR): наблюдатель не должен зависеть от
  // наблюдаемого. С 2026-07-26 здесь токен @hermesbymxpk_bot — того же бота, через
  // которого владелец говорит со своим Hermes-агентом, чтобы алёрты и разговор с
  // ним были в одном диалоге. Он тоже только ОТПРАВЛЯЕТ отсюда: апдейты его
  // webhook'а слушает агент, а Telegram не шлёт боту события о его же исходящих
  // сообщениях, так что каналы не пересекаются.
  // Не задан → fallback на прод-бот (backward-compat).
  ALERT_BOT_TOKEN: optionalEnvString(),

  // Rate limit (per-identity, мера B1). Backend — Upstash Redis (HTTP REST).
  // Не заданы URL/TOKEN → limiter выключен (fail-open). Аварийный выключатель —
  // RATE_LIMIT_DISABLED='1'/'true' (читается в lib/ratelimit.ts).
  // Имена UPSTASH_* — ручная конвенция; KV_REST_API_* — то, что инжектит
  // интеграция Upstash через Vercel Marketplace. Поддерживаем оба (lib/ratelimit.ts).
  UPSTASH_REDIS_REST_URL: optionalUrl(),
  UPSTASH_REDIS_REST_TOKEN: optionalEnvString(),
  KV_REST_API_URL: optionalUrl(),
  KV_REST_API_TOKEN: optionalEnvString(),
  // Реверс-прокси перед Vercel (доступ сайта из РФ без VPN): РКН блокирует IP
  // Vercel, поэтому пользовательский трафик идёт через российский VPS-прокси
  // (Timeweb, Traefik). Эмпирически проверено: Vercel ЗАТИРАЕТ стандартные
  // `x-real-ip`/`x-forwarded-for` на IP соединения (= IP прокси), а кастомные
  // заголовки пробрасывает. Поэтому прокси кладёт реальный IP клиента в
  // `X-Client-IP` и секрет в `X-Proxy-Secret`; getClientIp верит `X-Client-IP`
  // ТОЛЬКО при timing-safe совпадении секрета (домен `*.vercel.app` принимает
  // трафик мимо прокси, где заголовок подделает любой клиент — CWE-348).
  // Не задан → ветка выключена, поведение как раньше (прямой Vercel).
  PROXY_SHARED_SECRET: optionalEnvString(),
  // Источник клиентского IP в getClientIp (lib/ratelimit.ts). 'vercel' (дефолт) —
  // доверяем `x-real-ip` (Vercel проставляет его сам из адреса соединения).
  // 'traefik' — self-host за Dokploy-Traefik: `x-real-ip` там НЕ доверенный
  // (Traefik пропускает клиентский заголовок насквозь — подделка обнуляла бы
  // per-IP лимит, CWE-348), доверенный источник — ПРАВЫЙ элемент
  // `x-forwarded-for`. Включать ТОЛЬКО после живой проверки контракта Traefik
  // на тестовом контуре (Фаза 3.4 docs/dokploy-migration-plan.md).
  // ДЕФОЛТ `traefik` (сменён с `vercel` 2026-07-28): прод и dev живут за
  // Dokploy-Traefik, Vercel остался только дальним резервом отката. Прежний
  // дефолт был небезопасным — потеря переменной (а правка env через API Dokploy
  // перезаписывает его ЦЕЛИКОМ) молча включала доверие к `x-real-ip`, который
  // за Traefik подделывается клиентом, и per-IP лимит обходился полностью
  // (CWE-348, инвариант 9). Ошибиться в сторону строгого режима безопаснее:
  // на Vercel неверный режим даёт слишком строгий лимит, а не дырявый.
  CLIENT_IP_MODE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['vercel', 'traefik']).default('traefik'),
  ),
  RATE_LIMIT_DISABLED: z
    .preprocess((v) => v === '1' || v === 'true', z.boolean())
    .default(false),

  // Trigger.dev (Sprint 3)
  TRIGGER_API_KEY: optionalEnvString(),
  TRIGGER_API_URL: z.string().url().default('https://api.trigger.dev'),

  // Observability
  SENTRY_DSN: optionalUrl(),
  SENTRY_AUTH_TOKEN: optionalEnvString(),

  // Vercel runtime (приходит автоматически)
  VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
})
  // Гейт «выбран провайдер — обязаны быть его ключи». Без него неизбежен
  // сценарий «переключили флаг, забыли ключ», и узнаём мы о нём от первого
  // клиента, а не от валидации: контейнер поднялся бы, кнопка «Оплатить»
  // отвечала бы 500.
  //
  // ⚠️ Гейт ОДНОСТОРОННИЙ — проверяются только ключи Freekassa. Симметричная
  // проверка ключей L&P сломала бы dev-стенд: там платёжных ключей нет
  // НАМЕРЕННО (иначе тестовый заказ выставит реальный счёт), а
  // `PAYMENT_PRIMARY_PROVIDER` там не задан и берёт дефолт `loveandpay` —
  // приложение просто перестало бы стартовать. Значение `freekassa`, наоборот,
  // задаётся руками и только на проде: раз задали — ключи обязаны быть.
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PRIMARY_PROVIDER !== 'freekassa') return;
    const required = [
      ['FREEKASSA_API_KEY', env.FREEKASSA_API_KEY],
      ['FREEKASSA_SHOP_ID', env.FREEKASSA_SHOP_ID],
      ['FREEKASSA_SECRET_WORD_2', env.FREEKASSA_SECRET_WORD_2],
    ] as const;
    for (const [name, value] of required) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `обязателен при PAYMENT_PRIMARY_PROVIDER=freekassa`,
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

// -------------------------------------------------------------------------
// Lazy-парсинг
// -------------------------------------------------------------------------

let cachedServerEnv: ServerEnv | null = null;

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Доступ к валидированным server-переменным.
 * Бросает читаемую ошибку при отсутствии обязательных ключей.
 */
export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverEnvSchema.safeParse(withoutEmptyValues(process.env));
  if (!parsed.success) {
    const msg = `Invalid server env:\n${formatIssues(parsed.error.issues)}`;
    // Не pino (L-8): env валидируется на bootstrap ДО инициализации логгера —
    // logger.ts сам зависит от serverEnv, console тут единственный канал.
    process.stderr.write(`${msg}\n`);
    throw new Error(msg);
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/** Proxy с ленивым разрешением — можно писать `serverEnv.SUPABASE_URL`. */
export const serverEnv = new Proxy({} as ServerEnv, {
  get(_target, key: string | symbol) {
    return getServerEnv()[key as keyof ServerEnv];
  },
}) as ServerEnv;
