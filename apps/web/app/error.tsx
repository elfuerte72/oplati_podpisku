'use client';

import { useEffect } from 'react';

import { usePathname } from 'next/navigation';

import * as Sentry from '@sentry/nextjs';

import { ComicButton } from '@/components/comic';
import { ErrorScene } from '@/components/comic/ErrorScene';

/**
 * Рантайм-ошибка (error boundary App Router) в стиле комикса. Ошибку
 * репортим в Sentry (never swallow errors), «Попробовать снова» — reset
 * (Next перерендерит сегмент).
 *
 * Выход отсюда — всегда ПОЛНАЯ перезагрузка документа (window.location),
 * не client-навигация: после краха рендера <Link> вернул бы в то же
 * сломанное React-дерево. Частный случай — ошибка на самой главной:
 * кнопка «На главную» была бы петлёй, поэтому на «/» она превращается в
 * «Перезагрузить страницу» (заодно лечит типовой ChunkLoadError после
 * свежего деплоя — стейл-чанки обновляются только полной перезагрузкой).
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const onHomePage = pathname === null || pathname === '/';

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
      <ComicButton
        variant="surface"
        onClick={() => {
          if (onHomePage) {
            window.location.reload();
          } else {
            window.location.assign('/');
          }
        }}
      >
        {onHomePage ? 'Перезагрузить страницу' : 'На главную'}
      </ComicButton>
    </ErrorScene>
  );
}
