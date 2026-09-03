'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { formatKopecks, orderStatusLabel } from '@/lib/panel/format';
import { SEARCH_TEXT } from '@/lib/panel/labels';
import {
  PANEL_SEARCH_DEBOUNCE_MS,
  PANEL_SEARCH_TIMEOUT_MS,
  answerMatchesQuery,
  clientHitHint,
  clientHitTitle,
  isSearchable,
  parseSearchResults,
  type PanelSearchResults,
} from '@/lib/panel/search';

/**
 * Быстрый поиск панели: ⌘K из любого экрана, заказы и клиенты в одной выдаче.
 *
 * ⚠️ Запрос уходит POST'ом. Ищут по почте и телефону клиента, а адрес попадает
 * в историю браузера, в `Referer` и в отчёт об ошибке — экран заказов уже
 * стоил нам правила в денилисте Sentry, чистящего `query_string`.
 *
 * Ответы гонки отбрасываются по номеру запроса: «ан» и «анн» уходят подряд, и
 * без этого выдача может застыть на более старом ответе, пришедшем позже.
 */
export function PanelSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  /**
   * Ответ помнит СВОЙ запрос. Так «показывать ли эту выдачу» — вопрос
   * сравнения при рендере, а не гонки сбросов: иначе после стирания текста на
   * экране на мгновение остаются найденные ранее клиенты.
   */
  const [answer, setAnswer] = useState<(PanelSearchResults & { query: string }) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // ⌘K / Ctrl+K открывает, Esc закрывает. Обработчик на документе, а не на
  // поле: смысл сочетания в том, чтобы не искать поле мышью.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
        // Диалог уже открыт, а фокус ушёл на ссылку выдачи: значение `open` не
        // меняется, эффект фокуса не сработает, и сочетание выглядит сломанным.
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !isSearchable(query)) return;

    const id = ++requestId.current;
    // Запрос обязан отменяться: без этого брошенный по новому вводу поиск
    // продолжает гонять четыре `ILIKE '%…%'` в том же процессе, что принимает
    // вебхуки, а зависший ответ навсегда оставляет на экране «Ищем…».
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), PANEL_SEARCH_TIMEOUT_MS);

    // Состояние трогаем ТОЛЬКО из таймера: синхронный setState в теле эффекта
    // вызывает каскад перерисовок, а «Ищем…» до истечения паузы показывать и
    // незачем — человек ещё печатает.
    const timer = setTimeout(() => {
      setStatus('loading');
      void fetch('/api/panel/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: abort.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`search failed: ${res.status}`);
          // Сужаем, а не приводим: ответ не той формы (200 от промежуточного
          // прокси) иначе роняет рендер вместо честного «поиск не удался».
          const payload: unknown = await res.json();
          return parseSearchResults(payload);
        })
        .then((data) => {
          if (id !== requestId.current) return;
          if (!data) {
            setStatus('failed');
            return;
          }
          setAnswer({ query: query.trim(), ...data });
          setStatus('idle');
        })
        .catch(() => {
          if (id !== requestId.current) return;
          // Отказ поиска — не повод для отчёта об ошибке: сотрудник видит
          // текст и повторяет ввод, а вот текст запроса во внешний сервис
          // уезжать не должен (в нём почта и телефон клиента).
          setStatus('failed');
        })
        .finally(() => clearTimeout(deadline));
    }, PANEL_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      abort.abort();
    };
  }, [open, query]);

  // Показываем только ответ на ТЕКУЩИЙ ввод: выдача по прежнему запросу рядом
  // со свежим текстом читается как результат поиска и вводит в заблуждение.
  const results = answerMatchesQuery(answer, query) ? answer : null;
  const nothingFound =
    results !== null && results.orders.length === 0 && results.clients.length === 0;

  return (
    <>
      <button type="button" className="panel-search__open" onClick={() => setOpen(true)}>
        <span aria-hidden>⌕</span>
        <span className="panel-search__open-label">{SEARCH_TEXT.open}</span>
        <kbd className="panel-search__hotkey" aria-hidden>
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div className="panel-search__layer">
          <button
            type="button"
            className="panel-search__backdrop"
            aria-label={SEARCH_TEXT.close}
            onClick={() => setOpen(false)}
          />
          <div className="panel-search__dialog" role="dialog" aria-modal="true" aria-label={SEARCH_TEXT.open}>
            <input
              ref={inputRef}
              type="search"
              className="panel-input"
              placeholder={SEARCH_TEXT.placeholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // Прежний отказ относился к прежнему вводу: иначе на экране
                // одновременно «введите два символа» и «поиск не удался».
                setStatus('idle');
              }}
            />

            <div className="panel-search__results">
              {!isSearchable(query) ? <p className="panel-muted">{SEARCH_TEXT.hintShort}</p> : null}
              {status === 'loading' ? <p className="panel-muted">{SEARCH_TEXT.searching}</p> : null}
              {status === 'failed' ? <p className="panel-muted">{SEARCH_TEXT.failed}</p> : null}
              {nothingFound ? <p className="panel-muted">{SEARCH_TEXT.nothing}</p> : null}

              {results && results.orders.length > 0 ? (
                <section>
                  <p className="panel-search__group">{SEARCH_TEXT.groupOrders}</p>
                  {results.orders.map((order) => (
                    <Link
                      key={order.shortId}
                      href={`/admin/orders/${order.shortId}`}
                      className="panel-search__hit"
                      onClick={() => setOpen(false)}
                    >
                      <span className="panel-search__hit-title">{order.shortId}</span>
                      <span className="panel-search__hit-hint">
                        {[order.clientName, order.serviceName, orderStatusLabel(order.status)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="panel-search__hit-amount">
                        {formatKopecks(order.amountRubKopecks)}
                      </span>
                    </Link>
                  ))}
                </section>
              ) : null}

              {results && results.clients.length > 0 ? (
                <section>
                  <p className="panel-search__group">{SEARCH_TEXT.groupClients}</p>
                  {results.clients.map((client) => (
                    <Link
                      key={client.id}
                      href={`/admin/clients/${client.id}`}
                      className="panel-search__hit"
                      onClick={() => setOpen(false)}
                    >
                      <span className="panel-search__hit-title">{clientHitTitle(client)}</span>
                      <span className="panel-search__hit-hint">{clientHitHint(client)}</span>
                    </Link>
                  ))}
                </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
