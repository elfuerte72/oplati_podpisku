import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { childLogger } from './logger.ts';
import { redisCredentialsFromEnv } from './redis.ts';

/**
 * Per-identity rate-limit на дорогие AI-эндпоинты (`/api/chat`, `/api/bot`).
 *
 * Зачем (мера B1 из docs/fix-plan.md): дневной токен-бюджет — глобальный, его
 * можно исчерпать на всех легитимных пользователей запросами одного абьюзера.
 * Лимит «на одного» режет такой DoS-на-бюджет ДО вызова роутера/агента.
 *
 * Хранилище — Upstash Redis (HTTP REST), НЕ Postgres: лимит продолжает работать,
 * даже когда Supabase недоступен (а именно тогда отключается бюджет — см.
 * apps/web/lib/ai/budget.ts). Sliding window.
 *
 * Конфигурация — env `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`,
 * либо `KV_REST_API_URL` + `KV_REST_API_TOKEN` (имена, которые инжектит
 * интеграция Upstash через Vercel Marketplace). Поддерживаем оба, приоритет —
 * UPSTASH_*. Не заданы → limiter выключен (fail-open): отдаём `allowed`, чтобы
 * не уронить продукт там, где Upstash ещё не подключён. Аварийный выключатель —
 * `RATE_LIMIT_DISABLED=1`.
 *
 * Fail-open и при ошибке самого Upstash: лучше пропустить запрос, чем уронить
 * чат; ошибка уходит в Sentry.
 */

const log = childLogger('ratelimit');

export type RateLimitResult = {
  /** Разрешить запрос. true и когда limiter выключен/недоступен (fail-open). */
  allowed: boolean;
  /** Сконфигурирован ли реальный backend (false → проверка не выполнялась). */
  configured: boolean;
  limit: number;
  remaining: number;
};

export type RateLimitName =
  | 'web-chat'
  | 'telegram'
  | 'web-order'
  | 'web-order-status'
  | 'web-link'
  | 'web-analytics'
  | 'telegram-start'
  | 'telegram-media'
  | 'cabinet'
  | 'cabinet-auth'
  | 'alert-webhook-auth'
  | 'admin-auth'
  | 'admin-totp'
  | 'staff-bot';

type LimiterConfig = { limit: number; windowSeconds: number };

// Окна подобраны под продукт (~50 заказов/день): живому пользователю хватает с
// запасом, абьюзеру — режет залп. Тюнится без изменения кода вызова.
// `web-order`/`web-link` (находка security-аудита): неаутентифицированные
// write-эндпоинты (`orders/propose|confirm`, `auth/telegram/link`) без лимита
// позволяли анониму без cookie заваливать БД строками users/orders/link_tokens —
// суточный кап «≤10 заказов» не спасал, т.к. каждый бескуковый запрос получает
// свежую сессию.
const CONFIGS: Record<RateLimitName, LimiterConfig> = {
  'web-chat': { limit: 12, windowSeconds: 60 },
  telegram: { limit: 20, windowSeconds: 60 },
  'web-order': { limit: 8, windowSeconds: 60 },
  // Отдельный бакет для ЧТЕНИЯ статуса (аудит 2026-07-28). После оплаты клиент
  // опрашивает `/api/orders/status` каждые 4 с до 5 минут — это ~15 запросов в
  // минуту против лимита 8 у общего с ним `web-order`. Итог был двойной: штамп
  // «ОПЛАЧЕНО» приходил поздно, а исчерпанный бакет блокировал СОЗДАНИЕ
  // следующего заказа с того же IP на пять минут. За CGNAT мобильных операторов
  // (основная аудитория) в один IP схлопывается несколько живых клиентов,
  // поэтому запас взят кратный: 60 = 4 клиента, опрашивающих одновременно.
  // Разделять безопасно: это read-only роут, он не создаёт ни сессий, ни строк.
  'web-order-status': { limit: 60, windowSeconds: 60 },
  // web-link: токен привязки выпускается ЗАРАНЕЕ при рендере кнопки (прямая
  // <a>-ссылка вместо window.open, фикс мобильной привязки 2026-07-03), а не
  // по клику — базовый расход выше, лимит поднят 5 → 10.
  'web-link': { limit: 10, windowSeconds: 60 },
  // Поведенческая аналитика: батч до 20 событий за запрос, отправка пачками с
  // debounce. Отдельный бакет ОБЯЗАТЕЛЕН — телеметрия шумнее любого другого
  // роута, и общий бакет с `web-order` она бы просто выедала, блокируя создание
  // заказов (ровно та авария, что была у `web-order-status` до 2026-07-28).
  // Потолок считается в СТРОКАХ, а не в запросах: 20 запросов × батч 10 = 200
  // событий в минуту с IP. Живому клиенту хватает с запасом (весь путь до
  // оплаты — десяток событий), а анониму раздувание тома, общего с боевой БД,
  // обходится дорого. Потеря события дешевле потери заказа, поэтому бакет
  // отдельный и на другие роуты не влияет.
  'web-analytics': { limit: 20, windowSeconds: 60 },
  // ОТДЕЛЬНЫЙ бакет для `/start` (аудит 2026-08-10). До него команда не
  // лимитировалась вовсе, хотя пишет больше всех: upsert `users`+`conversations`
  // и ДВЕ строки в `messages`. Но и в общий бакет её класть нельзя: `/start
  // link_<token>` — обязательный шаг оплаты для пришедшего с сайта (без
  // `telegram_id` `confirm_order` платёжную ссылку не выдаёт), и он не должен
  // упираться в лимит, выеденный болтовнёй, альбомом скриншотов или нажатиями
  // кнопок. Свой бакет: команду по-прежнему нельзя крутить бесконечно, но
  // «съесть» его посторонним трафиком невозможно. 10/мин — человеку хватает
  // с запасом, повторный `/start` осмыслен раз в несколько секунд.
  'telegram-start': { limit: 10, windowSeconds: 60 },
  // Медиа — тоже свой бакет. До аудита медиа-ветка возвращалась ДО лимита и не
  // стоила ничего; загнав её в общий `telegram`, мы бы отдали альбом скриншотов
  // (Telegram шлёт по апдейту на фото, до 10 за раз) в тот же кошелёк, из
  // которого платят inline-кнопки и `/support` — клиент, приславший скриншоты
  // проблемы, лишался бы кнопки обращения в поддержку ровно тогда, когда она
  // нужна (ревью 2026-08-11). Отдельный бакет: медиа ограничено, но никого не
  // голодит.
  'telegram-media': { limit: 20, windowSeconds: 60 },
  // Mini App (`/api/cabinet`) — СВОЙ per-identity бакет, а не общий с ботом
  // (аудит 2026-08-10). Общий `telegram` означал, что просмотр кабинета выедает
  // лимит бота и наоборот: каждое открытие заказа — это `fetchOrderDetail` +
  // `reloadSnapshot` на возврате, десяток переключений даёт 20 запросов. Тот же
  // мотив, по которому `web-order-status` отделили от `web-order` 2026-07-28.
  // Потолок выше прежних 20, но умеренно: `snapshot` тянет живой запрос в
  // PaySpace за балансом карты (`lib/cabinet/live-balance.ts`) и не кэшируется,
  // поэтому щедрость здесь оплачивается чужим API.
  cabinet: { limit: 30, windowSeconds: 60 },
  // Только НЕУДАЧНЫЕ проверки подписи `initData` на `/api/cabinet`, по IP.
  // Барьер для НЕаутентифицированного потока (инвариант 9): запрос без валидной
  // подписи не доходит до БД вообще, но HMAC и разбор тела чего-то стоят.
  // ⚠️ Успешные запросы этот бакет НЕ трогают намеренно — иначе IP стал бы
  // ключом на роуте, где каждый запрос уже криптографически опознан: за CGNAT
  // мобильных операторов и за собственным VPN Оплатишки (один egress-адрес на
  // всех клиентов) общий IP-бакет резал бы живых плательщиков за чужой флуд.
  // По тому же принципу устроен `alert-webhook-auth`.
  'cabinet-auth': { limit: 20, windowSeconds: 300 },
  // Только НЕУДАЧНЫЕ попытки авторизации на `/api/alerts/sentry`. Секрет ездит
  // в query (экшен «webhook» в Sentry не умеет кастомные заголовки), а значит
  // виден в access-логах Traefik — подбор и переигрывание надо ограничивать.
  //
  // ⚠️ Считаются ИМЕННО отказы. Лимитировать успешные алёрты нельзя: шторм
  // алёртов случается ровно тогда, когда всё горит, и молча отброшенное
  // уведомление хуже отсутствующего. Порог низкий: у настоящего Sentry секрет
  // верный с первого раза, промахиваться некому.
  'alert-webhook-auth': { limit: 10, windowSeconds: 300 },
  // Только НЕУДАЧНЫЕ попытки входа в админ-панель (`/api/panel/auth/*`), по IP.
  // Страница входа — неаутентифицированная точка входа (инвариант 9), а второй
  // фактор это шесть цифр: без потолка их перебирают.
  //
  // ⚠️ Считаются ИМЕННО отказы, как у `cabinet-auth` и `alert-webhook-auth`.
  // Лимит на все запросы означал бы, что чужой перебор с того же CGNAT-адреса
  // запирает снаружи живого сотрудника — то есть отказ в обслуживании себе.
  // 10 за 15 минут: человек, промахнувшийся кодом, укладывается с запасом,
  // перебор миллиона комбинаций — нет.
  'admin-auth': { limit: 10, windowSeconds: 900 },
  // Потолок перебора второго фактора ПО СОТРУДНИКУ. Расходуется на КАЖДУЮ
  // попытку, а не только на промах, и в этом весь смысл: при учёте одних
  // промахов пачка параллельных запросов успевает проверить тысячу кодов до
  // того, как счётчик их догонит, а УГАДАННЫЙ код проходит мимо лимитера вовсе.
  // Ключ — id сотрудника, поэтому чужой перебор не запирает соседа (в отличие
  // от общего IP за CGNAT). 8 попыток за 5 минут: человеку, промахнувшемуся
  // цифрой, хватает, перебору 10^6 комбинаций — нет.
  'admin-totp': { limit: 8, windowSeconds: 300 },
  // Бот ПЕРСОНАЛА, по отправителю. Бот публичный: клиент находит его поиском по
  // слову «support» и пишет туда. Без бакета каждое такое сообщение стоит нам
  // чтения БД и исходящего вызова Telegram. Отдельный от `telegram` — служебный
  // бот не должен выедать лимит клиентского и наоборот.
  'staff-bot': { limit: 10, windowSeconds: 60 },
};

// Резолв клиентского IP вынесен в `client-ip.ts` (антифрод-трек, тикет 01):
// та же логика доверия к заголовкам питает `users.last_seen_ip`. Реэкспорт
// сохраняет прежний импорт-путь у всех роутов.
export { getClientIp } from './client-ip.ts';

let cachedRedis: Redis | null = null;
const limiterCache = new Map<RateLimitName, Ratelimit>();

function isDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === '1' || process.env.RATE_LIMIT_DISABLED === 'true';
}

/** Ленивая инициализация Redis-клиента; null — если env не сконфигурирован. */
function getRedis(): Redis | null {
  if (cachedRedis) return cachedRedis;
  const creds = redisCredentialsFromEnv();
  if (!creds) return null;
  cachedRedis = new Redis(creds);
  return cachedRedis;
}

function getLimiter(name: RateLimitName): Ratelimit | null {
  const cached = limiterCache.get(name);
  if (cached) return cached;
  const redis = getRedis();
  if (!redis) return null;
  const cfg = CONFIGS[name];
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSeconds} s`),
    prefix: `rl:${name}`,
    analytics: false,
  });
  limiterCache.set(name, limiter);
  return limiter;
}

/**
 * Узнать состояние лимита, НЕ расходуя его.
 *
 * Нужно там, где считаются только НЕУДАЧНЫЕ попытки (`admin-auth`): при таком
 * учёте обычный `checkRateLimit` стоит на ветке отказа, а успешный вход мимо
 * лимитера проходит вовсе — и перебор шестизначного кода не останавливается,
 * он лишь получает 429 на неудачных попытках, а угаданный код всё равно
 * впускает. Поэтому вход СНАЧАЛА смотрит сюда (заблокирован ли адрес) и только
 * потом проверяет код, а расходует лимит на промахе.
 *
 * Никогда не бросает; при недоступном backend'е — fail-open, как и весь модуль.
 */
export async function peekRateLimit(
  name: RateLimitName,
  identity: string,
): Promise<RateLimitResult> {
  const cfg = CONFIGS[name];
  if (isDisabled()) {
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  const limiter = getLimiter(name);
  if (!limiter) {
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  try {
    const { remaining } = await limiter.getRemaining(identity);
    return { allowed: remaining > 0, configured: true, limit: cfg.limit, remaining };
  } catch (err) {
    log.error({ event: 'ratelimit.peek_failed', name, err });
    Sentry.captureException(err, { tags: { source: 'ratelimit', name } });
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }
}

/**
 * Проверка лимита для (name, identity). `identity` — IP (веб) или
 * telegram_id/chat_id (бот). Никогда не бросает.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identity: string,
): Promise<RateLimitResult> {
  const cfg = CONFIGS[name];
  if (isDisabled()) {
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  const limiter = getLimiter(name);
  if (!limiter) {
    // Upstash не подключён — fail-open (не блокируем продукт).
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }

  try {
    const { success, limit, remaining } = await limiter.limit(identity);
    if (!success) {
      log.warn({ event: 'ratelimit.blocked', name, limit, remaining });
    }
    return { allowed: success, configured: true, limit, remaining };
  } catch (err) {
    // Ошибка backend'а — fail-open, но фиксируем в Sentry.
    log.error({ event: 'ratelimit.check_failed', name, err });
    Sentry.captureException(err, { tags: { source: 'ratelimit', name } });
    return { allowed: true, configured: false, limit: cfg.limit, remaining: cfg.limit };
  }
}
