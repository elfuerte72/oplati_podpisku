import * as Sentry from '@sentry/nextjs';

import { sharedOptions } from '@/lib/sentry';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    ...sharedOptions,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
