/**
 * Гейт по хосту для панели — общая часть для двух эшелонов: `proxy.ts` (404 до
 * приложения) и `lib/panel/session.ts` (сессия не считается живой на чужом
 * хосте). Логика одна, поэтому и живёт в одном месте.
 *
 * ⚠️ FAIL-CLOSED НА ПРОДЕ. Незаданный `PANEL_HOST` в production закрывает
 * панель, а не открывает её на всех доменах. Прецедент прямо в этом
 * репозитории: `CLIENT_IP_MODE` годами имел «удобный» дефолт, и его потеря
 * молча снимала защиту (CWE-348) — а правка env через API Dokploy
 * перезаписывает блок ЦЕЛИКОМ, то есть потерять переменную легко. Здесь цена
 * ошибки — панель с заказами, клиентами и деньгами на публичном домене.
 *
 * В development гейт выключен: локальная разработка ходит на `localhost:3000`,
 * и жёсткий дефолт закрывал бы панель на своей же машине.
 */

export type PanelHostDecision = 'allow' | 'deny' | 'allow_dev';

export function decidePanelHost(input: {
  host: string | null | undefined;
  expected: string | null | undefined;
  isProduction: boolean;
}): PanelHostDecision {
  const expected = input.expected?.trim().toLowerCase();
  if (!expected) return input.isProduction ? 'deny' : 'allow_dev';

  // Порт отбрасываем: наружу смотрит 443, внутрь — что угодно.
  const host = input.host?.split(':')[0]?.trim().toLowerCase();
  return host && host === expected ? 'allow' : 'deny';
}

export function isPanelHostAllowed(input: {
  host: string | null | undefined;
  expected: string | null | undefined;
  isProduction: boolean;
}): boolean {
  return decidePanelHost(input) !== 'deny';
}
