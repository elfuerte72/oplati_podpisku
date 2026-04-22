import * as Sentry from '@sentry/nextjs';

import './sentry.client.config';

// Требуется Sentry SDK для инструментирования client-side навигаций (App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
