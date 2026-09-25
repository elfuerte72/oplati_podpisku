import * as Sentry from '@sentry/nextjs';

import { sharedOptions } from '@/lib/sentry';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    ...sharedOptions,
    integrations: [
      // Тело входящего запроса НЕ перехватываем (аудит CRM 2026-09-17, тикет 06).
      // По умолчанию `@sentry/node-core` 10.53 копит до ~10 КБ тела и кладёт его
      // строкой в `event.request.data` — у ошибок и у сэмплированных транзакций.
      // Уезжали поиск ⌘K по почте и телефону, код TOTP, `initData` кабинета,
      // текст ответа оператора. Второй эшелон на случай, если тело всё же
      // приедет, — `scrubRequestBody` в `lib/sentry.ts`.
      //
      // Экземпляр с тем же именем `Http` ЗАМЕНЯЕТ стандартный, который ставит
      // `@sentry/nextjs` (`filterDuplicates` в `@sentry/core`: пользовательский
      // побеждает дефолтный). Поэтому `disableIncomingRequestSpans: true`
      // повторяем за ним: спаны входящих запросов Next.js создаёт сам, и без
      // флага они задвоились бы.
      Sentry.httpIntegration({
        maxIncomingRequestBodySize: 'none',
        disableIncomingRequestSpans: true,
      }),
    ],
  });
}
