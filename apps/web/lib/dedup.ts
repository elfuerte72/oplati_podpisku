import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { Redis } from '@upstash/redis';

import { childLogger } from './logger.ts';
import { redisCredentialsFromEnv } from './redis.ts';

/**
 * «Заяви право на ключ ровно один раз» — межпроцессный дедуп коротких событий.
 *
 * Зачем (аудит 2026-08-10): Telegram переДОСТАВЛЯЕТ апдейт, если не получил
 * `200` вовремя, а наш обработчик синхронный и живёт до 90 с. Без дедупа повтор
 * проходил весь путь заново: второе сообщение клиенту, второй счёт по кнопке
 * `confirm`, второй вызов панели VPN, а при включённом AI — второй платный ход
 * агента.
 *
 * Хранилище — тот же Upstash-совместимый Redis, что под rate-limit. In-memory
 * нельзя принципиально: он не переживёт вторую реплику и рестарт контейнера,
 * то есть перестанет работать ровно тогда, когда деплой и раскатывается.
 *
 * ⚠️ Fail-OPEN и БЫСТРО. При незаданном, упавшем или ЗАВИСШЕМ Redis право
 * считается взятым: потерять апдейт хуже, чем обработать его дважды. Скорость
 * здесь такая же часть контракта, как направление отказа, — claim стоит ПЕРЕД
 * обработчиком, поэтому медленный ответ хранилища останавливает весь бот, включая
 * платёжные и кнопочные флоу, которым Redis вообще не нужен. Отсюда свой клиент
 * без ретраев и жёсткий предел ожидания.
 *
 * По той же причине здесь НЕ действует `RATE_LIMIT_DISABLED`: это разные
 * механизмы, и выключатель лимита не должен молча гасить дедуп.
 */

const log = childLogger('dedup');

/**
 * Сколько ждём Redis. Дедуп — вспомогательная проверка на пути, который и так
 * ограничен `maxDuration`; лучше пропустить возможный дубль, чем задержать
 * ответ клиенту.
 */
const CLAIM_TIMEOUT_MS = 1500;

let cachedRedis: Redis | null = null;

function getRedis(): Redis | null {
  if (cachedRedis) return cachedRedis;
  const creds = redisCredentialsFromEnv();
  if (!creds) return null;
  cachedRedis = new Redis({
    ...creds,
    // Ретраи выключены НАМЕРЕННО (дефолт библиотеки — 5 повторов с
    // экспоненциальным backoff). Каждый повтор — ещё один HTTP-запрос, и на
    // подвисшем Redis fail-open откладывался бы на минуты, пока бот молчит.
    retry: false,
  });
  return cachedRedis;
}

const TIMED_OUT = Symbol('dedup.timeout');

/**
 * Обрывает ожидание своим таймаутом.
 *
 * Возвращает символ, а не `null`: у `SET NX` именно `null` означает «ключ уже
 * занят», и слить его с «не дождались ответа» значило бы объявлять дублем любой
 * медленный ответ хранилища.
 */
async function withTimeout<T>(promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), CLAIM_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `true` — право взято этим вызовом (обрабатывай), `false` — ключ уже занят
 * (это дубль). Никогда не бросает.
 *
 * @param key         уникальный ключ события (включай идентификатор источника,
 *                    иначе два бота с одинаковыми номерами апдейтов погасят
 *                    сообщения друг друга).
 * @param ttlSeconds  сколько помнить ключ. Для «взял в работу» ставь срок чуть
 *                    больше времени жизни обработчика: умерший процесс ключ не
 *                    освободит, и слишком долгий TTL превратит ретрай Telegram —
 *                    единственный путь восстановления — в тихую потерю апдейта.
 *                    Досидевшую до конца работу продлевай `extendClaim`.
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;

  try {
    const res = await withTimeout(redis.set(key, '1', { nx: true, ex: ttlSeconds }));
    if (res === TIMED_OUT) {
      log.warn({ event: 'dedup.claim_timeout', key });
      return true;
    }
    // `SET NX` отдаёт 'OK' при захвате и null, когда ключ уже есть.
    return res !== null;
  } catch (err) {
    log.error({ event: 'dedup.claim_failed', key, err });
    Sentry.captureException(err, { tags: { source: 'dedup' } });
    return true;
  }
}

/**
 * Отпускает взятый ключ: работа НЕ состоялась, и право должно вернуться.
 *
 * Нужно там, где claim охраняет побочный эффект, который может не случиться
 * (подсказка «бот не молчит»: Telegram ответил ошибкой). Без возврата права
 * несостоявшаяся отправка запирала бы событие на весь TTL.
 *
 * Не бросает: не сняли ключ — худшее следствие в том, что повтор произойдёт
 * позже, по истечении срока.
 */
export async function releaseClaim(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await withTimeout(redis.del(key));
  } catch (err) {
    log.warn({ event: 'dedup.release_failed', key, err });
  }
}

/**
 * Продлевает уже взятый ключ: работа доведена до конца, повторять её не надо
 * даже если источник ретраит позже.
 *
 * Разделение на короткий claim и продление — защита от смерти процесса
 * (ревью 2026-08-11): ключ, поставленный сразу на длинный срок, при падении
 * контейнера в середине обработки гасил бы ретраи Telegram до конца TTL, а
 * ретрай там единственный путь восстановления.
 */
export async function extendClaim(key: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await withTimeout(redis.set(key, '1', { ex: ttlSeconds }));
  } catch (err) {
    // Не продлили — худшее следствие в том, что поздний ретрай обработается
    // повторно. Это ровно то, что дедуп и так допускает при сбое хранилища.
    log.warn({ event: 'dedup.extend_failed', key, err });
  }
}
