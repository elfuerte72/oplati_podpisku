/**
 * Копирование в буфер с fallback под Telegram WebView, где `navigator.clipboard`
 * часто заблокирован (нет permission / не тот контекст доверия). Возвращает
 * `true`, если хоть один способ сработал — вызывающий решает, что показать.
 *
 * Только браузер, только из обработчика клика: и Clipboard API, и `execCommand`
 * требуют жеста пользователя. Вынесено из `CabinetClient` (2026-09-05), когда
 * выяснилось, что партнёрский экран копировал «по-своему» — и на отказ буфера
 * показывал «Скопировано»: партнёр раздавал друзьям то, что лежало в буфере до
 * этого, и жаловался, что ссылка не работает.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false;
  // Основной путь — Clipboard API. Reject обрабатываем вторым коллбэком .then,
  // без bare catch — при неудаче падаем на execCommand ниже.
  if (navigator.clipboard?.writeText) {
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    // Бросок здесь (SecurityError и подобное) — не отказ буфера, а поломка
    // запасного пути: пользователю всё равно `false` и подсказка, но нам об этом
    // надо знать. Один раз на страницу — залипшая кнопка не должна штормить.
    reportFallbackFailure(err);
    return false;
  }
}

let fallbackFailureReported = false;
function reportFallbackFailure(err: unknown): void {
  if (fallbackFailureReported) return;
  fallbackFailureReported = true;
  void import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.captureException(err, { tags: { source: 'clipboard.fallback' } });
    })
    .catch(() => undefined);
}
