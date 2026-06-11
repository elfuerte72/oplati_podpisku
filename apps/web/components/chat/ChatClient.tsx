'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
import { LeftNav } from './LeftNav';
import { Mascot, type MascotPose } from './Mascot';
import { PROFILE_REFRESH_EVENT, ProfilePanel } from './ProfilePanel';
import { RichText } from './RichText';
import { TelegramLinkCard } from './TelegramLink';
import { ThemeToggle } from './ThemeToggle';
import { parseToolCards, type ChatCard } from './toolCards';

type ChatItem =
  | { kind: 'msg'; id: string; from: 'bot' | 'user'; text: string }
  | { kind: 'cards'; id: string; cards: ChatCard[] };

type ChatResponse = { ok: boolean; text?: string; toolCalls?: unknown; error?: string };
type ConfirmResponse = {
  ok: boolean;
  paymentUrl?: string;
  qrPayload?: string | null;
  expiresAt?: string;
  text?: string;
  error?: string;
};
type StatusResponse = { ok: boolean; status?: string; paid?: boolean };
type HistoryResponse = {
  ok: boolean;
  messages?: { id: string; role: 'user' | 'assistant' | 'operator'; content: string }[];
};

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 75; // ~5 минут

let _idSeq = 0;
function nextId(): string {
  _idSeq += 1;
  return `m${_idSeq}`;
}

export function ChatClient({ greeting }: { greeting: string }) {
  const [items, setItems] = useState<ChatItem[]>(() => [
    { kind: 'msg', id: nextId(), from: 'bot', text: greeting },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
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
      setTimeout(() => setCelebrating(false), 3500);
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
        void fetch(`/api/orders/status?id=${encodeURIComponent(orderId)}`)
          .then((res) => res.json() as Promise<StatusResponse>)
          .then((data) => {
            if (data.ok && data.paid) {
              clearInterval(iv);
              pollsRef.current.delete(orderId);
              markPaid(orderId);
            }
          })
          .catch(() => {
            // транзиентная ошибка поллинга — следующий тик повторит
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
      polls.forEach((iv) => clearInterval(iv));
      polls.clear();
    };
  }, []);

  // Восстановление диалога из БД (источник правды) — иначе перезагрузка
  // страницы «сбрасывает» чат, хотя история сохранена на сервере.
  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    void fetch('/api/chat/history')
      .then((res) => res.json() as Promise<HistoryResponse>)
      .then((data) => {
        const msgs = data.messages ?? [];
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
          const greetingItem = prev[0];
          return greetingItem ? [greetingItem, ...restored] : restored;
        });
      })
      .catch(() => {
        // история недоступна — стартуем с приветствия, /api/chat работает независимо
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
      setItems((prev) => [...prev, { kind: 'msg', id: nextId(), from: 'user', text: trimmed }]);
      setInput('');
      setSending(true);
      setPoseSettling('thinking');

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
        });
        const data = (await res.json()) as ChatResponse;
        if (data.ok) {
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
        const res = await fetch('/api/orders/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId }),
        });
        const data = (await res.json()) as ConfirmResponse;
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
  // в БД), клиент сбрасывается к приветствию.
  const clearChat = useCallback(async () => {
    if (clearing || sending) return;
    setClearing(true);
    setError(null);
    try {
      const res = await fetch('/api/chat/clear', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean };
      if (data.ok) {
        pollsRef.current.forEach((iv) => clearInterval(iv));
        pollsRef.current.clear();
        setItems([{ kind: 'msg', id: nextId(), from: 'bot', text: greeting }]);
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
  }, [clearing, sending, greeting, setPoseSettling]);

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

        {/* Низ: ошибка, ввод */}
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
      </section>

      <ProfilePanel pose={pose} typing={sending} />
    </div>
  );
}
