import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@oplati/agent', '@oplati/db', '@oplati/types'],
  typedRoutes: true,
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
