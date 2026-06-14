import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@oplati/agent', '@oplati/db', '@oplati/types'],
  typedRoutes: true,
  // Базовые security-заголовки для всего приложения (платёжно-связанный UI).
  // CSP намеренно не задаём здесь — у комикс-UI инлайн-стили/скрипты Next,
  // строгий CSP легко всё сломает; это отдельная задача (см. docs/fix-plan.md D3).
  async headers() {
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
