'use client';

/**
 * Экран ошибки панели.
 *
 * Зачем: страницы панели ходят в базу напрямую, а рабочий стол — сразу в
 * несколько выборок. Моргнувшая база без этого файла роняет в пятисотку
 * ПЕРВЫЙ экран после входа, и человек видит служебную страницу Next вместо
 * объяснения. Конвенция проекта — graceful degradation: понятный ответ, не 500.
 *
 * ⚠️ Текст ошибки наружу не печатаем: в сообщении драйвера БД может оказаться
 * строка таблицы (`Failing row contains (…)`), то есть данные клиента.
 */
export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Своего логирования здесь нет намеренно: исключение уже ушло в Sentry через
  // глобальный обработчик Next, а `console.*` в проде запрещён конвенцией.
  // Человеку нужен `digest` — по нему запись и находится.
  return (
    <div className="panel-card" style={{ margin: 24 }}>
      <h1 className="panel-title">Экран не открылся</h1>
      <p className="panel-muted">
        Данные не загрузились — обычно это ненадолго. Попробуй обновить; если повторяется,
        посмотри Sentry: {error.digest ? `код ${error.digest}` : 'запись есть в логе'}.
      </p>
      <button type="button" className="panel-button" onClick={reset} style={{ marginTop: 12 }}>
        Обновить
      </button>
    </div>
  );
}
