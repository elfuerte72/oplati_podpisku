import { NextResponse } from 'next/server';

/**
 * ВРЕМЕННЫЙ debug-роут (не production): показывает, какие IP-заголовки доходят
 * до Vercel-функции за реверс-прокси Timeweb. Нужен, чтобы правильно построить
 * `getClientIp` при переводе прода на прокси (план «сайт без VPN из РФ»).
 *
 * Гейт: только НЕ production (VERCEL_ENV !== 'production') — в проде отдаёт 404.
 * Секретные значения не раскрываем: наличие `x-cf-proxy-secret` показываем
 * булевым флагом, не значением. Удалить после снятия замеров.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request): NextResponse {
  if ((process.env.VERCEL_ENV ?? '') === 'production') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const h = req.headers;
  return NextResponse.json({
    'x-forwarded-for': h.get('x-forwarded-for'),
    'x-real-ip': h.get('x-real-ip'),
    'x-vercel-forwarded-for': h.get('x-vercel-forwarded-for'),
    'x-vercel-proxied-for': h.get('x-vercel-proxied-for'),
    'cf-connecting-ip': h.get('cf-connecting-ip'),
    'x-client-ip': h.get('x-client-ip'),
    'x-proxy-secret-present': h.get('x-proxy-secret') !== null,
    'x-real-client-ip': h.get('x-real-client-ip'),
  });
}
