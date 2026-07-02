'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { siTelegram } from 'simple-icons';

import { ComicButton } from '@/components/comic';
import { fetchWithTimeout } from '@/lib/http';

/**
 * Привязка Telegram к веб-сессии (deep-link flow).
 *
 * `useTelegramLink` инкапсулирует весь клиентский цикл: POST
 * /api/auth/telegram/link → открыть t.me/<bot>?start=link_<token> → поллить
 * /api/auth/telegram/link/status, пока бот не подтвердит привязку. Серверная
 * половина — handle-update.ts (`/start link_*`) + consumeLinkToken.
 *
 * Используется в двух местах: карточка в ленте чата (гейт перед оплатой)
 * и кнопка в интро-оверлее.
 */

type StartResponse = { ok: boolean; url?: string; text?: string };
type StatusResponse = { ok: boolean; linked?: boolean };

export type TelegramLinkPhase = 'unknown' | 'idle' | 'starting' | 'waiting' | 'linked' | 'error';

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 240; // ~10 минут — дальше токен всё равно истёк

/**
 * Кнопок привязки на странице несколько (интро, профиль, гейт в чате) — у
 * каждой свой экземпляр хука. Чтобы привязка, завершённая в одном месте,
 * мгновенно отражалась во всех, успешный экземпляр бродкастит это событие,
 * остальные слушают. Плюс recheck при возврате фокуса на вкладку — ловит
 * случай «привязался из закрытого интро / другого окна».
 */
const LINKED_EVENT = 'oplatishka:telegram-linked';

export function useTelegramLink(opts?: { onLinked?: () => void; checkOnMount?: boolean }) {
  const checkOnMount = opts?.checkOnMount ?? false;
  const [phase, setPhase] = useState<TelegramLinkPhase>(checkOnMount ? 'unknown' : 'idle');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  useEffect(() => stopPoll, [stopPoll]);

  const markLinked = useCallback(
    (o: { notify: boolean; broadcast: boolean }) => {
      if (linkedRef.current) return;
      linkedRef.current = true;
      stopPoll();
      setPhase('linked');
      if (o.notify) onLinkedRef.current?.();
      if (o.broadcast) window.dispatchEvent(new Event(LINKED_EVENT));
    },
    [stopPoll],
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

  const startPoll = useCallback(() => {
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

  const start = useCallback(async () => {
    setPhase('starting');
    // КРИТИЧНО (мобильные): вкладку под бота открываем СИНХРОННО в обработчике
    // клика — ДО await. Если открыть `window.open` после `await fetch`, браузер
    // теряет user-activation и блокирует попап (Safari/Chrome на iOS/Android) —
    // кнопка «ничего не делает», Telegram не открывается. Сначала открываем
    // about:blank в user-gesture, затем перенаправляем на deep-link.
    // 'noopener' здесь НЕ ставим намеренно: с ним window.open вернул бы null, а
    // нам нужна ссылка на окно, чтобы сменить его location (opener гасим вручную).
    const preopened =
      typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
    try {
      const res = await fetchWithTimeout('/api/auth/telegram/link', { method: 'POST' });
      const data = (await res.json()) as StartResponse;
      if (data.ok && data.url) {
        if (preopened && !preopened.closed) {
          try {
            preopened.opener = null;
          } catch {
            // некоторые браузеры запрещают запись opener — не критично
          }
          preopened.location.replace(data.url);
        } else {
          // Попап заблокирован даже синхронно (редко) — уводим текущую вкладку;
          // возврат на сайт поймает привязку через visibilitychange-recheck.
          window.location.href = data.url;
        }
        setPhase('waiting');
        startPoll();
      } else {
        preopened?.close();
        setPhase('error');
      }
    } catch {
      preopened?.close();
      setPhase('error');
    }
  }, [startPoll]);

  return { phase, start };
}

export function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d={siTelegram.path} />
    </svg>
  );
}

const BUTTON_LABEL: Record<TelegramLinkPhase, string> = {
  unknown: 'Связать Telegram',
  idle: 'Связать Telegram',
  starting: 'Открываю Telegram…',
  waiting: 'Жду подтверждения…',
  linked: 'Telegram привязан',
  error: 'Не вышло — ещё раз',
};

export function TelegramLinkButton({
  phase,
  onStart,
  className = '',
}: {
  phase: TelegramLinkPhase;
  onStart: () => void;
  className?: string;
}) {
  return (
    <ComicButton
      onClick={onStart}
      disabled={phase === 'starting' || phase === 'waiting' || phase === 'linked' || phase === 'unknown'}
      className={`inline-flex items-center gap-2 ${className}`}
    >
      <TelegramIcon className="h-4 w-4 shrink-0" />
      {BUTTON_LABEL[phase]}
    </ComicButton>
  );
}

/**
 * Карточка-гейт в ленте чата: подтверждение оплаты отклонено, потому что
 * веб-пользователь не привязал Telegram. После привязки caller (ChatClient)
 * автоматически повторяет подтверждение заказа.
 */
export function TelegramLinkCard({ onLinked }: { onLinked?: () => void }) {
  const { phase, start } = useTelegramLink({ ...(onLinked ? { onLinked } : {}) });

  return (
    <div className="w-fit max-w-[min(92%,28rem)] rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)] motion-safe:animate-[comic-pop_180ms_var(--ease-pop)_both]">
      <p className="font-display text-base font-bold text-[var(--text)]">Остался один шаг</p>
      <p className="mt-1 font-body text-sm text-[var(--text-muted)]">
        Чек об оплате и доступы по заказу придут сообщением в Telegram — привяжи аккаунт, это один
        тап: жми кнопку и нажми Start в боте.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <TelegramLinkButton phase={phase} onStart={() => void start()} />
      </div>
      {phase === 'waiting' && (
        <p className="mt-2 font-body text-xs text-[var(--text-muted)]">
          Жду Start в боте — как только нажмёшь, продолжу автоматически.
        </p>
      )}
      {phase === 'linked' && (
        <p className="mt-2 font-body text-xs text-[var(--accent)]">
          Готово! Продолжаю оформление…
        </p>
      )}
    </div>
  );
}
