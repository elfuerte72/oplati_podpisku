'use client';

import { useEffect } from 'react';

import * as Sentry from '@sentry/nextjs';

/**
 * Крайний фолбэк: ошибка в самом root layout (app/error.tsx её не ловит).
 * Рендерится ВМЕСТО layout, поэтому объявляет свои <html>/<body> и не может
 * рассчитывать ни на globals.css, ни на шрифты, ни на комикс-компоненты —
 * только инлайн-стили и системный шрифт. Единственный надёжный выход —
 * полная перезагрузка документа.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error, { tags: { source: 'app.global_error' } });
  }, [error]);

  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          textAlign: 'center',
          background: '#0f0d11',
          color: '#fbfcf7',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        }}
      >
        <p style={{ fontSize: 64, fontWeight: 700, margin: 0, color: '#268b89' }}>Упс!</p>
        <h1 style={{ fontSize: 22, margin: 0 }}>Сайт споткнулся</h1>
        <p style={{ margin: 0, maxWidth: 420, color: '#a9a7ae' }}>
          Что-то сломалось при загрузке. Перезагрузи страницу — обычно этого хватает.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 12,
            padding: '12px 24px',
            fontSize: 16,
            fontWeight: 700,
            color: '#fbfcf7',
            background: '#268b89',
            border: '2.5px solid #0b0a0d',
            borderRadius: 16,
            boxShadow: '4px 4px 0 #0b0a0d',
            cursor: 'pointer',
          }}
        >
          Перезагрузить страницу
        </button>
      </body>
    </html>
  );
}
