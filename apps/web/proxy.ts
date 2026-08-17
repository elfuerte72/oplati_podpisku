import { NextResponse, type NextRequest } from 'next/server';

import { decidePanelHost } from '@/lib/panel/host';

/**
 * Гейт по хосту для админ-панели — защита в глубину.
 *
 * Файл называется `proxy.ts`: в Next 16 конвенция `middleware.ts` объявлена
 * устаревшей и переименована.
 *
 * Панель обязана открываться только по `admin.oplatishka.com`; на публичных
 * доменах `/admin` и `/api/panel` отдают 404. Маршрутизацию делает Traefik
 * (`infra/traefik/oplatishka-admin.yml.example`), но полагаться ТОЛЬКО на неё
 * нельзя: ошибка в конфиге прокси не должна означать открытую панель.
 *
 * ⚠️ Это не замена авторизации. Настоящая проверка доступа живёт в каждой
 * операции панели (`lib/panel/session.ts`), и она же независимо сверяет хост.
 *
 * Решение о хосте — в `lib/panel/host.ts` (общее с сессией). На проде
 * незаданный `PANEL_HOST` закрывает панель, а не открывает.
 */

// Рантайм не объявляем: proxy в Next 16 всегда Node.js, и `runtime` в конфиге
// он отвергает. Для нас это важно по существу — `PANEL_HOST` задаётся в env
// приложения Dokploy ПОСЛЕ сборки образа, а edge читал бы значение из сборки.
export const config = {
  matcher: ['/admin/:path*', '/api/panel/:path*'],
};

export function proxy(req: NextRequest): NextResponse {
  const decision = decidePanelHost({
    host: req.headers.get('host'),
    expected: process.env.PANEL_HOST,
    isProduction: process.env.NODE_ENV === 'production',
  });

  // Именно 404, а не 403: посторонний не должен узнать, что панель существует.
  return decision === 'deny' ? new NextResponse(null, { status: 404 }) : NextResponse.next();
}
