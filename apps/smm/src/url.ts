/**
 * Ключ адреса для сравнения и дедупа.
 *
 * Один материал приходит из канала, RSS и HN одновременно — и почти всегда с
 * разными хвостами: `habr.com` подставляет `utm_source`, соседний канал —
 * свой `erid`. Сырой адрес в роли ключа означает три строки об одном событии
 * в ленте идей и три платных оценки вместо одной.
 *
 * Модуль намеренно без зависимостей: его зовут и хранилище, и конвейер, а
 * конвейеру про хранилище знать нельзя (канарейка границ).
 */

const TRACKING = /^(utm_|yclid|gclid|fbclid|erid|_openstat|ysclid)/i;

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key)) url.searchParams.delete(key);
    }
    const host = url.host.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}${url.search}`;
  } catch {
    // Не адрес вовсе — ключом становится сам текст: терять элемент из-за
    // кривой ссылки хуже, чем хранить его как есть.
    return raw.trim().toLowerCase();
  }
}
