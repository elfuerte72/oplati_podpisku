'use client';

import { useEffect } from 'react';

import Link from 'next/link';

import * as Sentry from '@sentry/nextjs';

import { ComicButton, comicButtonClassName } from '@/components/comic';
import { ErrorScene } from '@/components/comic/ErrorScene';

/**
 * Рантайм-ошибка (error boundary App Router) в стиле комикса. Ошибку
 * репортим в Sentry (never swallow errors) и даём «Попробовать снова»
 * (reset — Next перерендерит сегмент) + выход на главную.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, { tags: { source: 'app.error_boundary' } });
  }, [error]);

  return (
    <ErrorScene
      code="Упс!"
      title="Что-то пошло не так"
      text="Уже разбираюсь, что случилось. Попробуй ещё раз — обычно этого хватает."
    >
      <ComicButton onClick={() => reset()}>Попробовать снова</ComicButton>
      <Link href="/" className={comicButtonClassName('surface')}>
        На главную
      </Link>
    </ErrorScene>
  );
}
