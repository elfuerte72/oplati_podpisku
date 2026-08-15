import 'server-only';

import { isIP } from 'node:net';

import { serverEnv } from './env.server.ts';
import { timingSafeEqualStr } from './security/timing-safe.ts';

/**
 * Резолв клиентского IP из запроса — единый для rate-limit и антифрод-трека
 * (`users.last_seen_ip`, который уходит Freekassa как IP плательщика).
 *
 * Вынесен из `ratelimit.ts` (антифрод-трек, тикет 01): логика доверия к
 * заголовкам одна на оба потребителя, и дублирование разъехалось бы ровно в
 * security-чувствительном месте (CWE-348).
 */

/**
 * Клиентский IP для rate-limit и `users.last_seen_ip`.
 *
 * SECURITY (CWE-348): `x-real-ip` Vercel проставляет сам из реального адреса
 * соединения — клиент его подделать не может. А ЛЕВЫЙ элемент `x-forwarded-for`
 * полностью подконтролен клиенту (Vercel добавляет реальный IP в КОНЕЦ цепочки,
 * не вырезая клиентское значение), поэтому доверять ему для security-решений
 * нельзя: ротация заголовка обнуляла бы per-IP лимит. Приоритет — `x-real-ip`;
 * `x-forwarded-for` — только fallback (локально/не-Vercel), и то ПРАВЫЙ элемент,
 * добавленный ближайшим доверенным прокси.
 *
 * За реверс-прокси (российский VPS, доступ из РФ без VPN — РКН блокирует IP
 * Vercel) адрес соединения для Vercel — это IP прокси, и `x-real-ip` для ВСЕХ
 * посетителей схлопывается в один IP: per-IP лимит начал бы резать живых
 * пользователей. Эмпирически проверено: Vercel затирает стандартные
 * `x-real-ip`/`x-forwarded-for` IP-адресом соединения, но кастомные заголовки
 * пробрасывает. Поэтому прокси кладёт реальный IP клиента в `X-Client-IP`, а в
 * `X-Proxy-Secret` — общий секрет; доверяем `X-Client-IP` ТОЛЬКО при timing-safe
 * совпадении секрета (домен `*.vercel.app` принимает трафик МИМО прокси, где оба
 * заголовка подделает любой клиент — та же CWE-348). Секрет
 * (`PROXY_SHARED_SECRET`) не задан → ветка мертва, поведение прежнее.
 *
 * Self-host за Dokploy-Traefik (`CLIENT_IP_MODE=traefik`,
 * docs/history/dokploy-migration-plan.md): `x-real-ip` там НЕ доверенный — Traefik
 * пропускает клиентский заголовок насквозь, не затирая (в отличие от Vercel),
 * и подделка обнуляла бы per-IP лимит (та же CWE-348). Доверенный источник —
 * ПРАВЫЙ элемент `x-forwarded-for`: Traefik с дефолтным `forwardedHeaders`
 * (без trustedIPs) срезает входящие X-Forwarded-* и пишет реальный адрес
 * соединения; даже если конфиг append'ит — правый элемент добавлен самим
 * Traefik. Режим включать ТОЛЬКО после живой проверки контракта на тестовом
 * контуре (Фаза 3.4: curl с поддельными заголовками НЕ должен менять identity).
 */
export function getClientIp(req: Request): string {
  const proxySecret = serverEnv.PROXY_SHARED_SECRET;
  if (proxySecret) {
    const providedSecret = req.headers.get('x-proxy-secret');
    const clientIp = normalizeIp(req.headers.get('x-client-ip'));
    if (providedSecret && clientIp && timingSafeEqualStr(providedSecret, proxySecret)) {
      return clientIp;
    }
  }

  if (serverEnv.CLIENT_IP_MODE === 'traefik') {
    // За Traefik клиентскому `x-real-ip` верить нельзя — только правый XFF.
    // Нет валидного XFF → 'unknown', и это ОСОЗНАННО fail-closed: такие запросы
    // делят один bucket. Фолбэк на `x-real-ip` здесь был бы регрессом
    // безопасности (клиент подделает заголовок и обнулит лимит, CWE-348).
    // Публичный трафик всегда идёт через Traefik; мимо него ходит только
    // внутренний healthcheck на /api/health, который не лимитируется.
    return rightmostForwardedFor(req) ?? 'unknown';
  }

  const realIp = normalizeIp(req.headers.get('x-real-ip'));
  if (realIp) return realIp;

  return rightmostForwardedFor(req) ?? 'unknown';
}

/**
 * Правый (добавленный ближайшим доверенным прокси) элемент X-Forwarded-For.
 *
 * Берём СТРОГО правый: если он не парсится как IP — возвращаем null, а НЕ идём
 * левее. Левые элементы подконтрольны клиенту, и «добор» по цепочке вернул бы
 * ровно ту дыру, от которой этот код защищает.
 */
function rightmostForwardedFor(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return null;
  const parts = xff
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return normalizeIp(parts[parts.length - 1]);
}

/**
 * Приводит значение заголовка к каноническому IP или отдаёт null.
 *
 * SECURITY: без нормализации `x-forwarded-for: 1.2.3.4:56789` от прокси,
 * который пишет `host:port`, давал бы НОВУЮ identity на каждом соединении
 * (эфемерный порт меняется всегда) — per-IP лимит обходился бы полностью, то
 * есть cost-DoS на строки БД и на дневной AI-бюджет. Мусор («unknown»,
 * obfuscated-идентификаторы из RFC 7239, пустая строка) тоже не должен
 * становиться ключом лимита, поэтому валидация через `node:net`, а не «взять
 * что дали».
 */
function normalizeIp(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let value = trimmed;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed?.[1]) {
    // `[2001:db8::1]:443` → `2001:db8::1`
    value = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    // `1.2.3.4:56789` → `1.2.3.4`
    value = value.slice(0, value.lastIndexOf(':'));
  }

  return isIP(value) === 0 ? null : value.toLowerCase();
}
