import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Сравнение секретов в постоянное время (anti-timing-attack).
 *
 * Сравниваем не сами строки, а их SHA-256 дайджесты (всегда 32 байта): это
 * убирает утечку длины через ранний выход и `timingSafeEqual` никогда не бросит
 * на разной длине входов. Используется для secret-хедеров (`X-Telegram-Bot-Api-
 * Secret-Token`, `X-Internal-Token`) и cron-токенов вместо `===`/`!==`.
 *
 * (Тот же принцип, что уже применяется к подписи L&P в `loveandpay/sign.ts`.)
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a, 'utf8').digest();
  const bHash = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aHash, bHash);
}
