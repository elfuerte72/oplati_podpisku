'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { siTelegram } from 'simple-icons';

import { ComicButton, comicButtonClassName } from '@/components/comic';
import { fetchWithTimeout } from '@/lib/http';

/**
 * Привязка Telegram к веб-сессии (deep-link flow).
 *
 * `useTelegramLink` инкапсулирует клиентский цикл: заранее выпустить токен
 * (POST /api/auth/telegram/link) → отдать готовый deep-link `telegram.me/<bot>?start=
 * link_<token>` для НАСТОЯЩЕЙ `<a>`-ссылки → после тапа поллить
 * /api/auth/telegram/link/status, пока бот не подтвердит привязку. Серверная
 * половина — handle-update.ts (`/start link_*`) + consumeLinkToken.
 *
 * КРИТИЧНО (мобильные): переход в Telegram должен быть прямым тапом по якорю
 * с уже готовым href. Telegram HTTPS deep-link открывает приложение
 * ТОЛЬКО при user-tap-навигации; прежняя схема `window.open('about:blank')` +
 * `location.replace` после await загружала веб-страницу t.me с интерстишлом
 * (лишние тапы) или вовсе застревала на пустой вкладке, когда iOS замораживал
 * фоновую вкладку до редиректа. По данным прода такие привязки не доходили до
 * бота вообще (токены выпускались, но не потреблялись).
 *
 * Используется в трёх местах: карточка-гейт в ленте чата (перед оплатой),
 * интро-оверлей, панель профиля.
 */

type StartResponse = { ok: boolean; url?: string; expiresAt?: string; text?: string };
type StatusResponse = { ok: boolean; linked?: boolean };

export type TelegramLinkPhase = 'unknown' | 'idle' | 'waiting' | 'linked' | 'error';

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 240; // ~10 минут — дальше токен всё равно истёк
/** Перевыпуск токена незадолго до конца TTL — ссылка под пальцем всегда живая. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_FALLBACK_TTL_MS = 10 * 60_000;

/**
 * Кнопок привязки на странице несколько (интро, профиль, гейт в чате) — у
 * каждой свой экземпляр хука. Чтобы привязка, завершённая в одном месте,
 * мгновенно отражалась во всех, успешный экземпляр бродкастит это событие,
 * остальные слушают. Плюс recheck при возврате фокуса на вкладку — ловит
 * случай «привязался из закрытого интро / другого окна».
 */
const LINKED_EVENT = 'oplatishka:telegram-linked';

export function useTelegramLink(opts?: {
  onLinked?: () => void;
  checkOnMount?: boolean;
  /**
   * Выпускать ли токен заранее. По умолчанию true; выключается для мест, где
   * кнопка смонтирована, но не видна (закрытый drawer профиля, первый кадр
   * интро) — чтобы не плодить токены на каждый просмотр страницы.
   */
  prefetch?: boolean;
}) {
  const checkOnMount = opts?.checkOnMount ?? false;
  const prefetch = opts?.prefetch ?? true;
  const [phase, setPhase] = useState<TelegramLinkPhase>(checkOnMount ? 'unknown' : 'idle');
  const [url, setUrl] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchingRef = useRef(false);
  const linkedRef = useRef(false);
  const onLinkedRef = useRef(opts?.onLinked);
  const onLinked = opts?.onLinked;
  useEffect(() => {
    onLinkedRef.current = onLinked;
  }, [onLinked]);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopRefresh = useCallback(() => {
    if (refreshRef.current) {
      clearTimeout(refreshRef.current);
      refreshRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      stopPoll();
      stopRefresh();
    },
    [stopPoll, stopRefresh],
  );

  const markLinked = useCallback(
    (o: { notify: boolean; broadcast: boolean }) => {
      if (linkedRef.current) return;
      linkedRef.current = true;
      stopPoll();
      stopRefresh();
      setPhase('linked');
      if (o.notify) onLinkedRef.current?.();
      if (o.broadcast) window.dispatchEvent(new Event(LINKED_EVENT));
    },
    [stopPoll, stopRefresh],
  );

  // Привязка завершилась в другом экземпляре хука (интро/профиль/гейт).
  useEffect(() => {
    const onLinkedEvent = () => markLinked({ notify: true, broadcast: false });
    window.addEventListener(LINKED_EVENT, onLinkedEvent);
    return () => window.removeEventListener(LINKED_EVENT, onLinkedEvent);
  }, [markLinked]);

  // Возврат на вкладку (например, из Telegram) — перепроверить статус, даже
  // если активного поллинга нет (его источник мог размонтироваться).
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== 'visible' || linkedRef.current) return;
      void fetchWithTimeout('/api/auth/telegram/link/status', {}, 5000)
        .then((res) => res.json() as Promise<StatusResponse>)
        .then((data) => {
          if (data.linked === true) markLinked({ notify: true, broadcast: true });
        })
        .catch(() => {
          // транзиентная ошибка — не критично, поймаем в следующий раз
        });
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [markLinked]);

  // При монтировании (интро/профиль): если сессия уже привязана — кнопку не показываем.
  useEffect(() => {
    if (!checkOnMount) return;
    let cancelled = false;
    void fetch('/api/auth/telegram/link/status')
      .then((res) => res.json() as Promise<StatusResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data.linked === true) {
          // Без notify: привязка случилась раньше, авто-действия не нужны.
          linkedRef.current = true;
          setPhase('linked');
        } else {
          setPhase('idle');
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [checkOnMount]);

  /**
   * Выпуск (или перевыпуск) токена. Ссылка кладётся в state и живёт в href
   * якоря; по таймеру перевыпускается до истечения TTL, пока не привязались.
   * Самовызов из setTimeout — через ref (useCallback не может ссылаться на
   * себя напрямую, react-hooks/immutability).
   */
  const requestTokenRef = useRef<() => Promise<void>>(async () => {});
  const requestToken = useCallback(async () => {
    if (fetchingRef.current || linkedRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetchWithTimeout('/api/auth/telegram/link', { method: 'POST' });
      const data = (await res.json()) as StartResponse;
      // Привязка завершилась, пока запрос летел — токен больше не нужен,
      // состояние linked не трогаем (находка ревью).
      if (linkedRef.current) return;
      if (data.ok && data.url) {
        setUrl(data.url);
        // Из error возвращаемся в idle; waiting не трогаем (не сбить поллинг).
        setPhase((p) => (p === 'error' ? 'idle' : p));
        stopRefresh();
        const ttlMs = data.expiresAt ? new Date(data.expiresAt).getTime() - Date.now() : NaN;
        const safeTtl = Number.isFinite(ttlMs) ? ttlMs : TOKEN_FALLBACK_TTL_MS;
        refreshRef.current = setTimeout(
          () => {
            void requestTokenRef.current();
          },
          Math.max(safeTtl - TOKEN_REFRESH_MARGIN_MS, 30_000),
        );
      } else {
        setUrl(null);
        // Сбой ФОНОВОГО перевыпуска не должен ломать уже идущую привязку:
        // waiting/linked сохраняем, error показываем только из idle
        // (находка ревью Greptile P2 / CodeRabbit).
        setPhase((p) => (p === 'waiting' || p === 'linked' ? p : 'error'));
      }
    } catch {
      if (!linkedRef.current) {
        setUrl(null);
        setPhase((p) => (p === 'waiting' || p === 'linked' ? p : 'error'));
      }
    } finally {
      fetchingRef.current = false;
    }
  }, [stopRefresh]);
  useEffect(() => {
    requestTokenRef.current = requestToken;
  }, [requestToken]);

  // Предвыпуск токена, как только известно, что сессия не привязана.
  // Из error автоматически не ретраим (не молотить сервер) — только по кнопке.
  // Через ref: setState внутри requestToken асинхронный (после await), но
  // react-hooks/set-state-in-effect статически этого не видит.
  // prefetch выключился (drawer закрылся) → гасим refresh-таймер, чтобы
  // скрытая кнопка не выпускала токены вечно; при повторном включении
  // перевыпускаем (таймера нет — токен мог истечь, пока drawer был закрыт).
  useEffect(() => {
    if (!prefetch) {
      stopRefresh();
      return;
    }
    if (phase !== 'idle' && phase !== 'waiting') return;
    if (url !== null && refreshRef.current !== null) return;
    void requestTokenRef.current();
  }, [prefetch, phase, url, stopRefresh]);

  /** Вызывается в onClick якоря: сам переход делает браузер по href. */
  const opened = useCallback(() => {
    if (linkedRef.current) return;
    setPhase('waiting');
    stopPoll();
    let attempts = 0;
    pollRef.current = setInterval(() => {
      attempts += 1;
      if (attempts > POLL_MAX_ATTEMPTS) {
        stopPoll();
        setPhase('idle');
        return;
      }
      void fetchWithTimeout('/api/auth/telegram/link/status', {}, 5000)
        .then((res) => res.json() as Promise<StatusResponse>)
        .then((data) => {
          if (data.linked === true) markLinked({ notify: true, broadcast: true });
        })
        .catch(() => {
          // транзиентная ошибка поллинга — следующий тик повторит
        });
    }, POLL_INTERVAL_MS);
  }, [stopPoll, markLinked]);

  /** После error: перезапросить токен (кнопка «Не вышло — ещё раз»). */
  const retry = useCallback(() => {
    setPhase('idle');
    void requestToken();
  }, [requestToken]);

  return { phase, url, opened, retry };
}

export function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d={siTelegram.path} />
    </svg>
  );
}

/**
 * Кнопка привязки. Когда deep-link готов — это настоящая `<a>` (universal
 * link открывает приложение Telegram только при прямом тапе по ссылке);
 * во всех остальных состояниях — ComicButton.
 */
export function TelegramLinkButton({
  phase,
  url,
  onOpen,
  onRetry,
  variant = 'primary',
  className = '',
}: {
  phase: TelegramLinkPhase;
  url: string | null;
  onOpen: () => void;
  onRetry: () => void;
  variant?: 'primary' | 'surface';
  className?: string;
}) {
  const content = (label: string) => (
    <>
      <TelegramIcon className="h-4 w-4 shrink-0" />
      {label}
    </>
  );
  const mergedClassName = `inline-flex items-center gap-2 ${className}`;

  if (url && (phase === 'idle' || phase === 'waiting')) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onOpen}
        className={comicButtonClassName(variant, mergedClassName)}
      >
        {content(phase === 'waiting' ? 'Открыть Telegram ещё раз' : 'Связать Telegram')}
      </a>
    );
  }
  if (phase === 'error') {
    return (
      <ComicButton onClick={onRetry} variant={variant} className={mergedClassName}>
        {content('Не вышло — ещё раз')}
      </ComicButton>
    );
  }
  return (
    <ComicButton disabled variant={variant} className={mergedClassName}>
      {content(
        phase === 'linked'
          ? 'Telegram привязан'
          : phase === 'waiting'
            ? 'Жду подтверждения…'
            : 'Связать Telegram',
      )}
    </ComicButton>
  );
}

/**
 * Запасной выход, когда тап по ссылке не открыл Telegram (нет приложения,
 * in-app браузер зарезал переход): даём скопировать deep-link, чтобы открыть
 * его в самом Telegram или другом браузере. Показывать в состоянии waiting.
 */
export function TelegramLinkFallback({
  url,
  className = '',
}: {
  url: string | null;
  className?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (!url) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2500);
    } catch {
      // clipboard недоступен (старый браузер/не-secure контекст) — честно
      // показываем ссылку текстом для ручного копирования (находка ревью).
      setCopyState('failed');
    }
  };

  return (
    <p className={`font-body text-xs text-[var(--text-muted)] ${className}`}>
      Telegram не открылся?{' '}
      <button
        type="button"
        onClick={() => void copy()}
        className="font-bold text-[var(--accent)] underline underline-offset-2"
      >
        {copyState === 'copied' ? 'Ссылка скопирована!' : 'Скопируй ссылку'}
      </button>{' '}
      и вставь её в Telegram или адресную строку браузера.
      {copyState === 'failed' && (
        <span className="mt-1 block break-all font-mono text-[11px] text-[var(--text)]">
          {url}
        </span>
      )}
    </p>
  );
}

/**
 * Карточка-гейт в ленте чата: подтверждение оплаты отклонено, потому что
 * веб-пользователь не привязал Telegram. После привязки caller (ChatClient)
 * автоматически повторяет подтверждение заказа.
 */
export function TelegramLinkCard({ onLinked }: { onLinked?: () => void }) {
  const { phase, url, opened, retry } = useTelegramLink({ ...(onLinked ? { onLinked } : {}) });

  return (
    <div className="w-fit max-w-[min(92%,28rem)] rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)] motion-safe:animate-[comic-pop_180ms_var(--ease-pop)_both]">
      <p className="font-display text-base font-bold text-[var(--text)]">Остался один шаг</p>
      <p className="mt-1 font-body text-sm text-[var(--text-muted)]">
        Чек об оплате и доступы по заказу придут сообщением в Telegram — привяжи аккаунт, это один
        тап: жми кнопку и нажми Start в боте.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <TelegramLinkButton phase={phase} url={url} onOpen={opened} onRetry={retry} />
      </div>
      {phase === 'waiting' && (
        <>
          <p className="mt-2 font-body text-xs text-[var(--text-muted)]">
            Жду Start в боте — как только нажмёшь, продолжу автоматически. Если счёт придёт в
            Telegram — можно оплатить и прямо там.
          </p>
          <TelegramLinkFallback url={url} className="mt-1.5" />
        </>
      )}
      {phase === 'linked' && (
        <p className="mt-2 font-body text-xs text-[var(--accent)]">
          Готово! Продолжаю оформление…
        </p>
      )}
    </div>
  );
}
