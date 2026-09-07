'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import {
  PANEL_EVENTS_PATH,
  PANEL_REFRESH_MS,
  canRefreshNow,
  createRefreshScheduler,
} from '@/lib/panel/live';

/**
 * Живое обновление списка (спека §3.4): по событию с сервера (SSE,
 * `GET /api/panel/events`, трек panel-live) экран перерисовывается сразу, а раз
 * в 25 секунд — страховкой на случай разрыва потока.
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

/**
 * Пометить страницу занятой на время операции.
 *
 * СЧЁТЧИКОМ, а не флагом: кнопок на экране много (напоминание рисуется на
 * каждой строке), и простое `setAttribute`/`removeAttribute` снимало бы
 * блокировку по первому завершившемуся запросу — живое обновление перерисовало
 * бы таблицу под второй операцией, которая ещё в полёте.
 */
let busyCount = 0;

export function markPanelBusy(): () => void {
  busyCount += 1;
  document.body.setAttribute(PANEL_BUSY_ATTRIBUTE, String(busyCount));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busyCount = Math.max(0, busyCount - 1);
    if (busyCount === 0) document.body.removeAttribute(PANEL_BUSY_ATTRIBUTE);
    else document.body.setAttribute(PANEL_BUSY_ATTRIBUTE, String(busyCount));
  };
}

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
    const canRefresh = () =>
      canRefreshNow({
        visible: document.visibilityState === 'visible',
        busy: document.body.hasAttribute(PANEL_BUSY_ATTRIBUTE),
        typing: isTyping(),
      });
    const refresh = () => router.refresh();

    const timer = setInterval(() => {
      if (canRefresh()) refresh();
    }, PANEL_REFRESH_MS);

    // Живые события: сервер шлёт `change`, когда в базе что-то изменилось;
    // переподключение при обрыве делает сам браузер. Событие, пришедшее в
    // скрытую вкладку, не теряется — добирается при возвращении.
    const scheduler = createRefreshScheduler({ refresh, canRefresh });
    const source = typeof EventSource === 'function' ? new EventSource(PANEL_EVENTS_PATH) : null;
    source?.addEventListener('change', () => scheduler.onEvent());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduler.onVisible();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(timer);
      source?.close();
      scheduler.dispose();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
