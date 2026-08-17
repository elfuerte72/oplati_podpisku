'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { PANEL_REFRESH_MS, canRefreshNow } from '@/lib/panel/live';

/**
 * Живое обновление списка (спека §3.4): раз в 25 секунд экран сам подтягивает
 * свежие данные.
 *
 * Обновляем через `router.refresh()`, а не своим запросом к API: страница —
 * серверный компонент, и рефреш перерисовывает ЕЁ же, без второго способа
 * получить те же данные (который неизбежно разъедется с первым).
 *
 * Сами условия «можно ли сейчас» живут в `lib/panel/live.ts` — они проверяемы
 * тестом, а здесь остаётся только чтение состояния DOM.
 */

/** Атрибут на `<body>`: операция панели в работе, обновлять нельзя. */
export const PANEL_BUSY_ATTRIBUTE = 'data-panel-busy';

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      const allowed = canRefreshNow({
        visible: document.visibilityState === 'visible',
        busy: document.body.hasAttribute(PANEL_BUSY_ATTRIBUTE),
        typing: isTyping(),
      });
      if (allowed) router.refresh();
    }, PANEL_REFRESH_MS);

    return () => clearInterval(timer);
  }, [router]);

  return null;
}
