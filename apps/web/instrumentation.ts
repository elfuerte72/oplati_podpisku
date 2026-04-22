/**
 * Next.js instrumentation hook.
 *
 * Запускается один раз на старте server/edge процесса.
 * Две задачи:
 *   1. Инициализировать Sentry для соответствующего runtime.
 *   2. Fail-fast проверка server-env: если обязательных переменных нет, падаем здесь,
 *      а не при первом запросе.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }

  // Fail-fast env validation (только на Node runtime и не во время билда).
  // NEXT_PHASE = 'phase-production-build' во время `next build` — пропускаем, чтобы
  // build мог собраться без .env.local (см. Risk #1 в плане).
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { getServerEnv } = await import('./lib/env');
    try {
      getServerEnv();
    } catch (err) {
      console.error('[instrumentation] env validation failed:', err);
      throw err;
    }
  }
}

// Sentry request-error capture — для App Router.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
