import { isIP } from 'node:net';

/**
 * Внутренние адреса: куда боту ходить нельзя.
 *
 * Страницу-первоисточник выбирает владелец, но редирект с неё выбирает тот,
 * кто владеет страницей. Без этой проверки взломанный сайт уводит бота на
 * `127.0.0.1` или `169.254.169.254`, ответ попадает в досье, модель
 * пересказывает его в пост — и внутренние данные уходят в канал.
 */

/** Имена, за которыми DNS не нужен: они внутренние по определению. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.home', '.lan'];

function ipv4Private(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64/10: адреса оператора, наружу они не ведут.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Широковещательный и мультикаст.
  if (a >= 224) return true;
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '');
  const kind = isIP(clean);
  if (kind === 4) return ipv4Private(clean);
  if (kind !== 6) return false;

  const lower = clean.toLowerCase();
  // IPv4-mapped (`::ffff:10.0.0.1`) — тот же IPv4, только записанный иначе.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return ipv4Private(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7 — уникальные локальные, fe80::/10 — link-local, ff00::/8 — мультикаст.
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

export function isPrivateHostname(host: string): boolean {
  const lower = host.trim().toLowerCase().replace(/\.$/, '');
  if (lower === '') return true;
  if (isPrivateAddress(lower)) return true;
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
