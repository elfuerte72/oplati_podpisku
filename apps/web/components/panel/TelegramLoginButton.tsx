'use client';

import { useEffect, useRef } from 'react';

/**
 * Кнопка Telegram Login Widget — первый фактор входа в панель.
 *
 * Скрипт виджета вставляется через `useEffect`, а не JSX-тегом `<script>`:
 * виджет читает свои настройки из `document.currentScript`, а React 19
 * поднимает script-теги из дерева в `<head>` — настройки при этом теряются, и
 * кнопка не появляется.
 *
 * ⚠️ Домен, на который виджет отдаёт подпись, задаётся у @BotFather
 * (`/setdomain`). Не совпал — Telegram молча не покажет кнопку.
 */
export function TelegramLoginButton({
  botUsername,
  authUrl,
}: {
  botUsername: string;
  authUrl: string;
}) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-auth-url', authUrl);
    // Разрешение писать сотруднику в личку: тот же бот доставляет уведомления
    // менеджеру, а бот не может написать тому, кто его не запускал.
    script.setAttribute('data-request-access', 'write');
    node.appendChild(script);

    return () => {
      node.replaceChildren();
    };
  }, [botUsername, authUrl]);

  return <div ref={holder} />;
}
