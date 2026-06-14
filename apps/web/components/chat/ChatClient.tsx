'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import {
  CatalogCard,
  ComicButton,
  Confetti,
  OrderPanel,
  PaidStamp,
  PaymentBlock,
  SpeechBubble,
  TypingBubble,
  formatExpires,
} from '@/components/comic';
import { fetchWithTimeout, parseJsonSafe } from '@/lib/http';
import { LeftNav } from './LeftNav';
import { Mascot, type MascotPose } from './Mascot';
import { PROFILE_REFRESH_EVENT, ProfilePanel } from './ProfilePanel';
import { RichText } from './RichText';
import { TelegramLinkCard } from './TelegramLink';
import { ThemeToggle } from './ThemeToggle';
import { StartScreen } from './StartScreen';
import { parseToolCards, type ChatCard } from './toolCards';

type ChatItem =
  | { kind: 'start'; id: string }
  | { kind: 'msg'; id: string; from: 'bot' | 'user'; text: string }
  | { kind: 'cards'; id: string; cards: ChatCard[] };

// Zod-схемы ответов API (валидируем форму вместо `as T` — не доверяем слепо).
const chatResponseSchema = z.object({
  ok: z.boolean(),
  text: z.string().optional(),
  toolCalls: z.unknown().optional(),
  error: z.string().optional(),
});
const confirmResponseSchema = z.object({
  ok: z.boolean(),
  paymentUrl: z.string().optional(),
  qrPayload: z.string().nullish(),
  expiresAt: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
});
const statusResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  paid: z.boolean().optional(),
});
const historyResponseSchema = z.object({
  ok: z.boolean(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'operator']),
        content: z.string(),
      }),
    )
    .optional(),
});

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 75; // ~5 минут

let _idSeq = 0;
function nextId(): string {
  _idSeq += 1;
  return `m${_idSeq}`;
}

export function ChatClient() {
  const [items, setItems] = useState<ChatItem[]>(() => [{ kind: 'start', id: nextId() }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Поле ввода на стартовом экране скрыто — раскрывается «Своим вариантом»
  // или само, как только начался диалог/появился заказ.
  const [inputRevealed, setInputRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [paidOrders, setPaidOrders] = useState<string[]>([]);
  const [celebrating, setCelebrating] = useState(false);
  const [pose, setPose] = useState<MascotPose>('wave');

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const historyLoadedRef = useRef(false);

  // Поза маскота: ставим pose, опционально откатываемся в idle через settleMs.
  const setPoseSettling = useCallback((p: MascotPose, settleMs?: number) => {
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = null;
    setPose(p);
    if (settleMs) {
      settleRef.current = setTimeout(() => setPose('idle'), settleMs);
    }
  }, []);

  // Кульминация оплаты: штамп на заказе + конфетти + ликование маскота.
  const markPaid = useCallback(
    (orderId: string) => {
      setPaidOrders((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]));
      setCelebrating(true);
      setPoseSettling('celebrate', 4000);
      if (celebrateTimerRef.current) clearTimeout(celebrateTimerRef.current);
      celebrateTimerRef.current = setTimeout(() => setCelebrating(false), 3500);
      // Статистика в панели профиля изменилась — пусть перечитает /api/profile.
      window.dispatchEvent(new Event(PROFILE_REFRESH_EVENT));
    },
    [setPoseSettling],
  );

  // Поллинг статуса заказа после создания счёта — до оплаты или таймаута.
  const startPoll = useCallback(
    (orderId: string) => {
      if (pollsRef.current.has(orderId)) return;
      let attempts = 0;
      const iv = setInterval(() => {
        attempts += 1;
        if (attempts > POLL_MAX_ATTEMPTS) {
          clearInterval(iv);
          pollsRef.current.delete(orderId);
          return;
        }
        void fetchWithTimeout(`/api/orders/status?id=${encodeURIComponent(orderId)}`, {}, 5000)
          .then((res) => parseJsonSafe(res, statusResponseSchema))
          .then((data) => {
            if (data?.ok && data.paid) {
              clearInterval(iv);
              pollsRef.current.delete(orderId);
              markPaid(orderId);
            }
          })
          .catch((err) => {
            // транзиентная ошибка поллинга — следующий тик повторит; фиксируем в Sentry
            Sentry.captureException(err, { tags: { source: 'chat-client', step: 'poll-status' } });
          });
      }, POLL_INTERVAL_MS);
      pollsRef.current.set(orderId, iv);
    },
    [markPaid],
  );

  // Старт: 'wave' (из useState) оседает в idle; на размонтаже гасим таймеры/интервалы.
  useEffect(() => {
    settleRef.current = setTimeout(() => setPose('idle'), 2200);
    const polls = pollsRef.current;
    return () => {
      if (settleRef.current) clearTimeout(settleRef.current);
      if (celebrateTimerRef.current) clearTimeout(celebrateTimerRef.current);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      polls.forEach((iv) => clearInterval(iv));
      polls.clear();
    };
  }, []);

  // Восстановление диалога из БД (источник правды) — иначе перезагрузка
  // страницы «сбрасывает» чат, хотя история сохранена на сервере.
  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    void fetchWithTimeout('/api/chat/history', {}, 8000)
      .then((res) => parseJsonSafe(res, historyResponseSchema))
      .then((data) => {
        const msgs = data?.messages ?? [];
        if (msgs.length === 0) return;
        const restored: ChatItem[] = msgs.map((m) => ({
          kind: 'msg',
          id: nextId(),
          from: m.role === 'user' ? 'user' : 'bot',
          text: m.content,
        }));
        setItems((prev) => {
          // Пользователь уже успел написать, пока грузилась история — не затираем.
          if (prev.some((it) => it.kind === 'msg' && it.from === 'user')) return prev;
          // Диалог уже был — стартовый экран не нужен, сразу обычный чат.
          return restored;
        });
      })
      .catch((err) => {
        // история недоступна — стартуем с приветствия, /api/chat работает независимо
        Sentry.captureException(err, { tags: { source: 'chat-client', step: 'load-history' } });
      });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, sending]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setError(null);
      setItems((prev) => [
        // Первое сообщение закрывает стартовый экран — дальше обычная лента.
        ...prev.filter((it) => it.kind !== 'start'),
        { kind: 'msg', id: nextId(), from: 'user', text: trimmed },
      ]);
      setInput('');
      setSending(true);
      setPoseSettling('thinking');

      try {
        // Таймаут 35с: агент (route maxDuration=30) может думать почти столько.
        const res = await fetchWithTimeout(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: trimmed }),
          },
          35_000,
        );
        const data = await parseJsonSafe(res, chatResponseSchema);
        if (!data) {
          setError('Технические проблемы. Попробуйте через минуту.');
          setPoseSettling('idle');
        } else if (data.ok) {
          const next: ChatItem[] = [];
          if (data.text) next.push({ kind: 'msg', id: nextId(), from: 'bot', text: data.text });
          const cards = parseToolCards(data.toolCalls);
          if (cards.length > 0) next.push({ kind: 'cards', id: nextId(), cards });
          if (next.length > 0) {
            setItems((prev) => [...prev, ...next]);
            setPoseSettling(cards.length > 0 ? 'presenting' : 'idle', cards.length > 0 ? 2800 : undefined);
          } else {
            setError('Пустой ответ. Попробуйте переформулировать.');
            setPoseSettling('idle');
          }
        } else {
          setError(data.text ?? 'Технические проблемы. Попробуйте через минуту.');
          setPoseSettling('idle');
        }
      } catch {
        setError('Нет связи. Проверьте интернет и попробуйте ещё раз.');
        setPoseSettling('idle');
      } finally {
        setSending(false);
      }
    },
    [sending, setPoseSettling],
  );

  const confirmOrder = useCallback(
    async (orderId: string) => {
      if (confirming !== null || confirmed.includes(orderId)) return;
      setConfirming(orderId);
      setError(null);
      try {
        // Таймаут 65с: confirm создаёт счёт L&P через self-call (maxDuration=60).
        const res = await fetchWithTimeout(
          '/api/orders/confirm',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ orderId }),
          },
          65_000,
        );
        const data = await parseJsonSafe(res, confirmResponseSchema);
        if (!data) {
          setError('Не получилось создать счёт. Попробуйте ещё раз или позовите оператора.');
          return;
        }
        const { paymentUrl, expiresAt } = data;
        if (data.ok && paymentUrl && expiresAt) {
          setConfirmed((prev) => [...prev, orderId]);
          setItems((prev) => [
            ...prev,
            {
              kind: 'cards',
              id: nextId(),
              cards: [{ type: 'payment', paymentUrl, qrPayload: data.qrPayload ?? null, expiresAt }],
            },
          ]);
          setPoseSettling('celebrate', 4000);
          startPoll(orderId);
        } else if (data.error === 'telegram_link_required') {
          // Гейт привязки: вместо ошибки — карточка «Связать Telegram»;
          // после привязки она сама повторит подтверждение этого заказа.
          setItems((prev) => [
            ...prev,
            { kind: 'cards', id: nextId(), cards: [{ type: 'telegram_link', orderId }] },
          ]);
        } else {
          setError(data.text ?? 'Не получилось создать счёт. Попробуйте ещё раз или позовите оператора.');
        }
      } catch {
        setError('Нет связи. Попробуйте ещё раз.');
      } finally {
        setConfirming(null);
      }
    },
    [confirming, confirmed, setPoseSettling, startPoll],
  );

  // «Очистить диалог»: сервер открывает новый conversation (история остаётся
  // в БД), клиент сбрасывается к стартовому экрану.
  const clearChat = useCallback(async () => {
    if (clearing || sending) return;
    setClearing(true);
    setError(null);
    try {
      const res = await fetchWithTimeout('/api/chat/clear', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean };
      if (data.ok) {
        pollsRef.current.forEach((iv) => clearInterval(iv));
        pollsRef.current.clear();
        setItems([{ kind: 'start', id: nextId() }]);
        setInputRevealed(false);
        setConfirmed([]);
        setPaidOrders([]);
        setCelebrating(false);
        setPoseSettling('wave', 2200);
      } else {
        setError('Не получилось очистить диалог. Попробуйте ещё раз.');
      }
    } catch {
      setError('Нет связи. Попробуйте ещё раз.');
    } finally {
      setClearing(false);
    }
  }, [clearing, sending, setPoseSettling]);

  // Кнопочный флоу стартового экрана: заказ создан без AI — карточка в ленту,
  // дальше обычный чат (подтверждение/оплата — существующий confirmOrder).
  const handleOrderCreated = useCallback(
    (card: ChatCard) => {
      setItems((prev) => [
        ...prev.filter((it) => it.kind !== 'start'),
        { kind: 'cards', id: nextId(), cards: [card] },
      ]);
      setInputRevealed(true);
      setPoseSettling('presenting', 2800);
    },
    [setPoseSettling],
  );

  // «Свой вариант»: раскрыть поле ввода и поставить фокус (textarea
  // монтируется этим же рендером — фокус после коммита).
  const revealInput = useCallback(() => {
    setInputRevealed(true);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => taRef.current?.focus(), 50);
  }, []);

  // Ошибки кнопочного флоу зовут «написать в чат» — раскрываем ввод сразу.
  const handleStartError = useCallback((text: string) => {
    setError(text);
    setInputRevealed(true);
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    // Пока пользователь набирает текст — Оплатишка внимательно «читает».
    // Не вмешиваемся, если идёт генерация ответа (там поза thinking).
    if (!sending) {
      setPoseSettling(value.trim().length > 0 ? 'attentive' : 'idle');
    }
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  };

  const renderCard = (card: ChatCard, key: string) => {
    switch (card.type) {
      case 'catalog':
        return (
          <div key={key} className="space-y-2">
            <p className="font-body text-xs text-[var(--text-muted)]">
              Нашёл в каталоге — нажми, чтобы выбрать:
            </p>
            <div className="flex flex-wrap gap-3">
              {card.items.map((it) => (
                <CatalogCard
                  key={it.id || it.name}
                  name={it.name}
                  requiresKyc={it.requiresKyc}
                  onSelect={() => void send(`Хочу ${it.name}`)}
                />
              ))}
            </div>
          </div>
        );
      case 'order': {
        const isPaid = paidOrders.includes(card.orderId);
        return (
          <OrderPanel
            key={key}
            service={card.service}
            rows={[
              { label: 'Номер заказа', value: card.shortId },
              { label: 'Действует до', value: formatExpires(card.expiresAt) },
            ]}
            amountKopecks={card.totalKopecks}
            stamp={isPaid ? <PaidStamp /> : undefined}
            confirm={
              <ComicButton
                onClick={() => void confirmOrder(card.orderId)}
                disabled={isPaid || confirming !== null || confirmed.includes(card.orderId)}
              >
                {isPaid
                  ? 'Оплачено'
                  : confirmed.includes(card.orderId)
                    ? 'Счёт создан'
                    : confirming === card.orderId
                      ? 'Создаю счёт…'
                      : 'Подтвердить и оплатить'}
              </ComicButton>
            }
          />
        );
      }
      case 'payment':
        return (
          <PaymentBlock
            key={key}
            paymentUrl={card.paymentUrl}
            qrPayload={card.qrPayload}
            expiresAt={card.expiresAt}
          />
        );
      case 'telegram_link': {
        const linkedOrderId = card.orderId;
        return (
          <TelegramLinkCard
            key={key}
            {...(linkedOrderId
              ? { onLinked: () => void confirmOrder(linkedOrderId) }
              : {})}
          />
        );
      }
      case 'operator':
        return (
          <p
            key={key}
            className="w-fit rounded-[var(--radius-card)] border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-2 font-body text-sm text-[var(--text)]"
          >
            Зову оператора{card.slaHours > 0 ? ` — ответит в течение ${card.slaHours} ч` : ''}. Оставайся
            на связи.
          </p>
        );
    }
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--bg)]">
      {celebrating && <Confetti />}

      <LeftNav />

      {/* Центр: чат */}
      <section className="relative flex min-w-0 flex-1 flex-col">
        {/* Шапка */}
        <header className="shrink-0 border-b-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)]">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <div className="relative flex items-center gap-3">
              {/* Маскот в шапке — только когда правая панель скрыта (один видимый маскот). */}
              <span className="lg:hidden">
                <Mascot pose={pose} size={44} />
              </span>
              <div className="leading-tight">
                <span className="block font-display text-lg font-bold text-[var(--text)]">
                  Оплатишка
                </span>
                <span className="flex items-center gap-1.5 font-body text-xs text-[var(--text-muted)]">
                  <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden />
                  online
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void clearChat()}
                disabled={clearing || sending}
                aria-label="Очистить диалог"
                title="Очистить диалог (история сохраняется на сервере)"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Лента диалога */}
        <div ref={scrollRef} className="halftone comic-scroll flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-5">
            {items.map((item) => {
              if (item.kind === 'start') {
                return (
                  <StartScreen
                    key={item.id}
                    onOrderCreated={handleOrderCreated}
                    onOwnVariant={revealInput}
                    onError={handleStartError}
                    onListOpen={() => setPoseSettling('presenting', 2800)}
                  />
                );
              }
              if (item.kind === 'cards') {
                return (
                  <div key={item.id} className="space-y-3">
                    {item.cards.map((c, i) => renderCard(c, `${item.id}-${i}`))}
                  </div>
                );
              }
              if (item.from === 'bot') {
                return (
                  <div key={item.id} className="flex justify-start">
                    <SpeechBubble from="bot">
                      <RichText text={item.text} />
                    </SpeechBubble>
                  </div>
                );
              }
              return (
                <div key={item.id} className="flex justify-end">
                  <SpeechBubble from="user">
                    <span className="whitespace-pre-wrap break-words">{item.text}</span>
                  </SpeechBubble>
                </div>
              );
            })}
            {sending && <TypingBubble />}
          </div>
        </div>

        {/* Низ: ошибка, ввод. На стартовом экране скрыт до «Своего варианта»
            или первого заказа/сообщения. */}
        {(inputRevealed || items.some((it) => it.kind !== 'start')) && (
        <div className="shrink-0 border-t-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)]">
          <div className="mx-auto w-full max-w-3xl px-4 py-3">
            {error && (
              <p
                role="alert"
                className="mb-3 rounded-[12px] border-2 border-[var(--color-stamp)] bg-[var(--surface-2)] px-3 py-2 font-body text-sm text-[var(--text)]"
              >
                {error}
              </p>
            )}

            <form onSubmit={onSubmit} className="flex items-end gap-2">
              <textarea
                ref={taRef}
                value={input}
                onChange={onInput}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={4000}
                aria-label="Сообщение Оплатишке"
                placeholder="Напишите сообщение…"
                className="comic-scroll max-h-40 min-h-[48px] flex-1 resize-none rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 font-body text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
              <ComicButton
                type="submit"
                disabled={sending || input.trim().length === 0}
                aria-label="Отправить"
                className="h-[48px] px-4"
              >
                →
              </ComicButton>
            </form>
          </div>
        </div>
        )}
      </section>

      <ProfilePanel pose={pose} typing={sending} />
    </div>
  );
}
