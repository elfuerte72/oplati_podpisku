import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

/**
 * CSP в режиме Report-Only (аудит 2026-07-11 F-12): ничего не блокирует, только
 * шлёт отчёты о нарушениях в Sentry (security-endpoint выводится из DSN).
 * План: собрать реальные нарушения с прода → ужесточить → перевести в enforce
 * (`Content-Security-Policy`). НЕ переводить в enforce без анализа отчётов:
 * у комикс-UI инлайн-стили Next, у Mini App — Telegram WebView.
 *
 * ⚠️ Разбирая отчёты, отделять свои нарушения от чужих. Большая часть шума —
 * `fonts.googleapis.com` / `fonts.gstatic.com` (сотни срабатываний) — приходит от
 * браузерных расширений посетителей, а НЕ от нас: шрифты self-hosted через
 * `next/font/google`, который скачивает их на сборке и раздаёт с `/_next/static/media`,
 * внешних ссылок в HTML нет. Добавлять такие домены в политику нельзя — это
 * ослабление ради чужих плагинов; они фильтруются на стороне Sentry
 * (Project Settings → Security Headers → ignored sources).
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
    // telegram.org — SDK Mini App (`telegram-web-app.js`), см.
    // components/cabinet/telegram.ts: он подгружается динамически из JS, поэтому
    // в HTML его не видно и при беглом взгляде нарушение выглядит чужим. Оно
    // наше: без этого домена перевод CSP в enforce убил бы кабинет в Telegram.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    // cdn.freekassa.net — баннер провайдера в футере (components/info/FreekassaBadge.tsx).
    // Без этого домена перевод CSP в enforce молча убил бы картинку, а для Freekassa
    // отсутствие баннера на главной = нарушение условий подтверждения ресурса.
    "img-src 'self' data: blob: https://cdn.freekassa.net",
    "font-src 'self' data:",
    "connect-src 'self' https://*.sentry.io https://vitals.vercel-insights.com",
    // Кнопка входа в панель — iframe `oauth.telegram.org`, его рисует
    // `telegram-widget.js`. Без своей директивы действует `default-src 'self'`:
    // сейчас это НАШЕ нарушение в report-only отчётах (которые заводились ради
    // чужих), а после перевода политики в enforce вход в панель просто умрёт.
    "frame-src https://oauth.telegram.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (reportUri) policy.push(`report-uri ${reportUri}`);
  return policy.join('; ');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone-выход для self-host в Docker (Dokploy, docs/dokploy-migration-plan.md):
  // `next build` дополнительно собирает `.next/standalone` — минимальный
  // `server.js` + вытрейсенные node_modules. Vercel этот режим игнорирует
  // (собирает своим пайплайном), на прод-деплой Vercel не влияет. Корень
  // трейсинга монорепо Next выводит сам по единственному pnpm-lock.yaml в корне.
  output: 'standalone',
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
