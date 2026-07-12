import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

/**
 * CSP в режиме Report-Only (аудит 2026-07-11 F-12): ничего не блокирует, только
 * шлёт отчёты о нарушениях в Sentry (security-endpoint выводится из DSN).
 * План: собрать реальные нарушения с прода → ужесточить → перевести в enforce
 * (`Content-Security-Policy`). НЕ переводить в enforce без анализа отчётов:
 * у комикс-UI инлайн-стили Next, у Mini App — Telegram WebView.
 */
function buildCspReportOnly(): string | null {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  // https://<key>@<host>/<projectId> → https://<host>/api/<projectId>/security/?sentry_key=<key>
  const m = dsn?.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  const reportUri = m ? `https://${m[2]}/api/${m[3]}/security/?sentry_key=${m[1]}` : null;
  const policy = [
    "default-src 'self'",
    // 'unsafe-inline'/'unsafe-eval' — стартовая точка под инлайны Next;
    // ужесточение (nonce) — после анализа отчётов.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.sentry.io https://vitals.vercel-insights.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (reportUri) policy.push(`report-uri ${reportUri}`);
  return policy.join('; ');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@oplati/agent', '@oplati/db', '@oplati/types'],
  typedRoutes: true,
  // Базовые security-заголовки для всего приложения (платёжно-связанный UI).
  // Enforce-CSP намеренно нет — сначала Report-Only (см. buildCspReportOnly).
  async headers() {
    const csp = buildCspReportOnly();
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // Браузерные API, которые приложению не нужны, — запрещаем явно.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          ...(csp ? [{ key: 'Content-Security-Policy-Report-Only', value: csp }] : []),
        ],
      },
    ];
  },
  images: {
    // Маскот версионируется query-строкой (?v=N) для сброса кэша браузера и
    // оптимизатора при замене ассетов (см. ASSET_VERSION в Mascot.tsx).
    localPatterns: [
      { pathname: '/mascot/**' }, // search не указан → любой query разрешён
      { pathname: '/**', search: '' }, // остальные локальные картинки — без query
    ],
  },
};

const hasSentryAuth = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Не пытаться аплоадить source maps без токена (local build / preview без secret'а).
  sourcemaps: {
    disable: !hasSentryAuth,
  },
});
