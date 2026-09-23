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
  /** Закрыть Mini App — возвращает пользователя в чат бота (там работает /support). */
  close?: () => void;
  /**
   * Bot API 6.9+: нативный запрос телефона (антифрод-трек, тикет 06). Callback
   * получает только boolean «поделился ли» — САМ НОМЕР приложению не отдаётся
   * (проверено по core.telegram.org/bots/webapps 2026-08-15): Telegram шлёт его
   * боту contact-сообщением, где его принимает `handleContactMessage`.
   */
  requestContact?: (callback?: (shared: boolean) => void) => void;
  /** Цвет фона мини-аппа (chrome) — выставляем под фирменный noir/paper. */
  setBackgroundColor?: (color: string) => void;
  /** Цвет шапки Telegram над мини-аппом. */
  setHeaderColor?: (color: string) => void;
  /** Цвет нижней панели (новые клиенты Telegram). */
  setBottomBarColor?: (color: string) => void;
  HapticFeedback?: {
    notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
    impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
    /** Щелчок смены выбора — смена вкладки (Bot API 6.1+). */
    selectionChanged?: () => void;
  };
  /**
   * Системная кнопка «Назад» в шапке Telegram (Bot API 6.1+). Листы Mini App
   * показывают её, пока открыты: иначе на Android системный жест «назад»
   * закрывал весь Mini App (трек miniapp-tabs, тикет 03). Все методы
   * необязательны — старые клиенты кнопки не знают.
   */
  BackButton?: TelegramBackButton;
  /** Нативная кнопка внизу экрана — «Оплатить» на листе заказа (тикет 05). */
  MainButton?: TelegramMainButton;
  /**
   * Bot API 7.7+: запретить сворачивание Mini App потягом вниз. Без этого потяг
   * листа или прокрутка вкладки вниз сворачивали приложение (тикет 03).
   * ⚠️ В клиентах постарше метод бывает объявлен, но бросает
   * `WebAppMethodUnsupported` — звать через try/catch.
   */
  disableVerticalSwipes?: () => void;
  /** Подписка на события SDK: `activated` — Mini App снова на экране (Bot API 8.0+). */
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
};

export type TelegramBackButton = {
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
};

export type TelegramMainButton = {
  setText?: (text: string) => void;
  show?: () => void;
  hide?: () => void;
  enable?: () => void;
  disable?: () => void;
  showProgress?: (leaveActive?: boolean) => void;
  hideProgress?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
  setParams?: (params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }) => void;
};

/**
 * Позвать метод SDK, пережив отказ. Старые клиенты Telegram держат методы на
 * объекте, но отвечают исключением `WebAppMethodUnsupported` — брошенное из
 * эффекта, оно уронило бы кабинет целиком ради необязательной мелочи.
 */
export function tolerateTelegram(call: () => void): void {
  try {
    call();
  } catch {
    // Этот клиент так не умеет — приложение работает без этой возможности.
  }
}

/** Текущий WebApp без загрузки SDK: для листов и кнопок, открытых после старта. */
export function currentTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const tg = window.Telegram?.WebApp;
  return tg && tg.initData ? tg : null;
}

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
