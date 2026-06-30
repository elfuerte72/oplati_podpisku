'use client';

/**
 * Тонкая обёртка над Telegram WebApp SDK для Mini App.
 *
 * SDK (`telegram-web-app.js`) подгружаем динамически и резолвим `window.Telegram.
 * WebApp`, когда он готов. Так страница кабинета остаётся обычным route в Next.js
 * без правки root layout (`beforeInteractive` там занят theme-init). Вне Telegram
 * (обычный браузер) `initData` пустой — кабинет покажет подсказку открыть из бота.
 */

export type TelegramWebApp = {
  initData: string;
  colorScheme?: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink?: (url: string) => void;
  /** Цвет фона мини-аппа (chrome) — выставляем под фирменный noir/paper. */
  setBackgroundColor?: (color: string) => void;
  /** Цвет шапки Telegram над мини-аппом. */
  setHeaderColor?: (color: string) => void;
  /** Цвет нижней панели (новые клиенты Telegram). */
  setBottomBarColor?: (color: string) => void;
  HapticFeedback?: {
    notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
    impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
  };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const SDK_URL = 'https://telegram.org/js/telegram-web-app.js';

export function loadTelegramWebApp(): Promise<TelegramWebApp | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);

  return new Promise((resolve) => {
    const finish = () => resolve(window.Telegram?.WebApp ?? null);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      // Скрипт мог уже загрузиться до навешивания слушателя.
      if (window.Telegram?.WebApp) resolve(window.Telegram.WebApp);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
}
