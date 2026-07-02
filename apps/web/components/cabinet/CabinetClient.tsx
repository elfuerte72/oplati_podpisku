'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatRub } from '@/components/comic/format';
import {
  IconArrowRight,
  IconCart,
  IconCheck,
  IconCopy,
  IconLink,
  IconSend,
  IconUsers,
} from '@/components/comic/icons';
import { PartnerCabinet } from '@/components/partner/PartnerCabinet';

import { loadTelegramWebApp, type TelegramWebApp } from './telegram';
import {
  doOperator,
  doPay,
  doRepeat,
  fetchCardDetails,
  fetchOrderDetail,
  fetchSnapshot,
  type OrderDetail,
  type Snapshot,
} from './cabinet-api';
import { Mascot } from '@/components/chat/Mascot';

import { CardHero, type CardDetails } from './CardHero';
import { CatalogView } from './CatalogView';
import { OrderDetailView, type DetailActionMessage } from './OrderDetailView';

type Phase = 'loading' | 'no-telegram' | 'error' | 'ready';

/** Человекочитаемый текст для технических кодов ошибок авторизации/загрузки. */
function errorTextFor(error: string): string {
  switch (error) {
    case 'expired':
      return 'Сессия устарела. Закрой кабинет и открой заново из бота.';
    case 'bad_signature':
    case 'missing_hash':
    case 'missing_user':
    case 'malformed':
      return 'Не удалось подтвердить вход из Telegram. Открой кабинет заново из бота.';
    case 'misconfigured':
      return 'Кабинет временно не настроен. Загляни немного позже.';
    default:
      return 'Не удалось загрузить данные. Попробуй обновить страницу.';
  }
}

/**
 * Копирование в буфер с fallback под Telegram WebView, где `navigator.clipboard`
 * часто заблокирован (не https-контекст доверия / нет permission). Возвращает
 * `true`, если хоть один способ сработал — вызывающий решает, что показать.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API есть, но заблокирован — не проглатываем, а падаем на
    // execCommand ниже; при его неудаче вернём false (сигнал вызывающему).
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
  } catch {
    return false;
  }
}

export function CabinetClient({ previewSnapshot }: { previewSnapshot?: Snapshot } = {}) {
  const [phase, setPhase] = useState<Phase>(previewSnapshot ? 'ready' : 'loading');
  const [errorText, setErrorText] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(previewSnapshot ?? null);
  const [view, setView] = useState<'list' | 'detail' | 'referral' | 'catalog'>('list');
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<'pay' | 'repeat' | 'operator' | null>(null);
  const [actionMsg, setActionMsg] = useState<DetailActionMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Реквизиты карты, показанные по кнопке (живой fetch, не хранятся). Сбрасываются
  // при уходе с экрана списка — чтобы не висели открытыми.
  const [cardDetails, setCardDetails] = useState<CardDetails | null>(null);
  const [revealingCard, setRevealingCard] = useState(false);
  const [refCopied, setRefCopied] = useState(false);

  const tgRef = useRef<TelegramWebApp | null>(null);
  const initDataRef = useRef<string>('');
  // initData в state (а не только в ref) — нужно при рендере секции «Партнёрам»
  // (PartnerCabinet получает initData как проп; ref читать в рендере нельзя).
  const [initData, setInitData] = useState('');

  // ─── Инициализация: SDK Telegram → snapshot ──────────────────────────────
  useEffect(() => {
    if (previewSnapshot) return; // превью/QA-seam: рендер без Telegram
    let cancelled = false;
    void (async () => {
      const tg = await loadTelegramWebApp();
      if (cancelled) return;
      if (!tg || !tg.initData) {
        setPhase('no-telegram');
        return;
      }
      tgRef.current = tg;
      initDataRef.current = tg.initData;
      setInitData(tg.initData);
      try {
        tg.ready();
        tg.expand();
        if (tg.colorScheme === 'light' || tg.colorScheme === 'dark') {
          document.documentElement.dataset.theme = tg.colorScheme;
        }
        // Подгоняем chrome Telegram (шапка/фон/низ) под фирменный --bg, иначе
        // поверх halftone видны чёрные полосы Telegram (фидбек владельца).
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (bg) {
          tg.setBackgroundColor?.(bg);
          tg.setHeaderColor?.(bg);
          tg.setBottomBarColor?.(bg);
        }
      } catch {
        // методы SDK не критичны — продолжаем
      }

      const res = await fetchSnapshot(tg.initData);
      if (cancelled) return;
      if (res.ok) {
        setSnapshot(res.data);
        setPhase('ready');
      } else {
        setErrorText(errorTextFor(res.error));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewSnapshot]);

  const reloadSnapshot = useCallback(async () => {
    const res = await fetchSnapshot(initDataRef.current);
    if (res.ok) setSnapshot(res.data);
  }, []);

  const revealCard = useCallback(async (cardId: string) => {
    setRevealingCard(true);
    const res = await fetchCardDetails(initDataRef.current, cardId);
    setRevealingCard(false);
    if (res.ok) {
      setCardDetails({ number: res.number, exp: res.exp, cvc: res.cvc });
    } else {
      setNotice('Не удалось показать реквизиты. Попробуй ещё раз.');
    }
  }, []);

  const hideCard = useCallback(() => setCardDetails(null), []);

  const openOrder = useCallback(async (orderId: string) => {
    setActionMsg(null);
    setNotice(null);
    setCardDetails(null); // прячем реквизиты при уходе со списка
    setDetailLoading(true);
    setView('detail');
    setDetail(null);
    const res = await fetchOrderDetail(initDataRef.current, orderId);
    setDetailLoading(false);
    if (res.ok) {
      setDetail(res.data);
    } else {
      setView('list');
      setNotice('Не удалось открыть заказ. Попробуй ещё раз.');
    }
  }, []);

  const refreshDetail = useCallback(async (orderId: string) => {
    const res = await fetchOrderDetail(initDataRef.current, orderId);
    if (res.ok) setDetail(res.data);
  }, []);

  const onPay = useCallback(async () => {
    if (!detail) return;
    setBusy('pay');
    setActionMsg(null);
    const res = await doPay(initDataRef.current, detail.orderId);
    setBusy(null);
    if (res.ok) {
      setActionMsg({ tone: 'ok', text: 'Счёт готов — открываю оплату.' });
      const tg = tgRef.current;
      if (tg) tg.openLink(res.paymentUrl);
      else window.open(res.paymentUrl, '_blank');
      void refreshDetail(detail.orderId);
      void reloadSnapshot();
    } else {
      setActionMsg({ tone: 'err', text: res.message });
    }
  }, [detail, refreshDetail, reloadSnapshot]);

  const onRepeat = useCallback(async () => {
    if (!detail) return;
    setBusy('repeat');
    setActionMsg(null);
    const res = await doRepeat(initDataRef.current, detail.orderId);
    setBusy(null);
    if (res.ok) {
      setActionMsg({
        tone: 'ok',
        text: `Новый заказ ${res.shortId} создан: ${res.service}, к оплате ${formatRub(res.totalKopecks)}. Он уже в списке заказов.`,
      });
      void reloadSnapshot();
    } else {
      setActionMsg({ tone: 'err', text: res.message });
    }
  }, [detail, reloadSnapshot]);

  const onOperator = useCallback(async () => {
    if (!detail) return;
    setBusy('operator');
    setActionMsg(null);
    const res = await doOperator(initDataRef.current, detail.orderId);
    setBusy(null);
    if (res.ok) {
      const when = res.withinBusinessHours
        ? `Оператор ответит в течение ${res.slaHours} ч.`
        : 'Оператор ответит утром, как начнётся рабочий день.';
      setActionMsg({
        tone: 'ok',
        text: res.duplicate ? `Заявка уже принята. ${when}` : `Заявка оператору отправлена. ${when}`,
      });
    } else {
      setActionMsg({ tone: 'err', text: res.message });
    }
  }, [detail]);

  // ─── Рендер ──────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return <CenteredNote text="Загружаю кабинет…" />;
  }
  if (phase === 'no-telegram') {
    return (
      <CenteredNote
        title="Открой кабинет в Telegram"
        text="Личный кабинет работает внутри Telegram. Открой бота и нажми кнопку меню «Кабинет»."
      />
    );
  }
  if (phase === 'error' || !snapshot) {
    return <CenteredNote title="Что-то пошло не так" text={errorText || 'Попробуй обновить страницу.'} />;
  }

  if (view === 'detail') {
    if (detailLoading || !detail) {
      return (
        <div className="mx-auto w-full max-w-md p-4">
          <CenteredNote text="Открываю заказ…" />
        </div>
      );
    }
    return (
      <main className="mx-auto w-full max-w-md p-4">
        <OrderDetailView
          order={detail}
          busy={busy}
          message={actionMsg}
          onBack={() => {
            setView('list');
            setDetail(null);
            setActionMsg(null);
          }}
          onPay={onPay}
          onRepeat={onRepeat}
          onOperator={onOperator}
        />
      </main>
    );
  }

  if (view === 'referral') {
    return <PartnerCabinet initData={initData} onBack={() => setView('list')} />;
  }

  // Кнопочный каталог: выбор сервиса → заказ → экран заказа с кнопкой «Оплатить».
  if (view === 'catalog') {
    return (
      <main className="mx-auto w-full max-w-md p-4">
        <CatalogView
          initData={initData}
          onBack={() => setView('list')}
          onCreated={(orderId) => {
            void openOrder(orderId);
          }}
        />
      </main>
    );
  }

  const firstName = snapshot.profile.displayName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Привет, ${firstName}!` : 'Привет!';
  // Основная карта: активная, иначе самая свежая по дате выпуска.
  const primaryCard =
    snapshot.cards.find((c) => c.status === 'active') ??
    [...snapshot.cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
    null;

  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4">
      {/* Компактная шапка вместо громоздкого ProfileHeader. */}
      <header className="flex items-center gap-3 pt-1">
        <Mascot pose="idle" size={40} />
        <div className="min-w-0">
          <p className="font-body text-xs text-[var(--text-muted)]">Личный кабинет</p>
          <h1 className="truncate font-display text-xl font-bold text-[var(--text)]">{greeting}</h1>
        </div>
      </header>

      {notice && (
        <p className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
          {notice}
        </p>
      )}

      {/* Главное действие кабинета — оплатить подписку через кнопочный каталог. */}
      <button
        type="button"
        onClick={() => {
          setCardDetails(null);
          setNotice(null);
          setView('catalog');
        }}
        className="flex w-full items-center gap-3 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--accent)] px-4 py-3.5 text-left shadow-[var(--shadow-comic)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
      >
        <IconCart size={22} className="shrink-0 text-[var(--color-paper)]" />
        <span className="flex-1 font-display text-[15px] font-bold text-[var(--color-paper)]">
          Выбрать сервис
        </span>
        <IconArrowRight size={18} className="shrink-0 text-[var(--color-paper)]" />
      </button>

      {/* Карта клиента — главный акцент. */}
      <CardHero
        card={primaryCard}
        details={cardDetails}
        revealing={revealingCard}
        onReveal={primaryCard ? () => revealCard(primaryCard.id) : undefined}
        onHide={hideCard}
      />

      {/* Отдельная кнопка на реферальную программу. */}
      <button
        type="button"
        onClick={() => {
          setCardDetails(null);
          setView('referral');
        }}
        className="flex w-full items-center gap-3 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-3 text-left shadow-[var(--shadow-comic)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
      >
        <IconUsers size={22} className="shrink-0 text-[var(--color-paper)]" />
        <span className="flex-1 font-display text-[15px] font-bold text-[var(--color-paper)]">
          Партнёрская программа
        </span>
        <IconArrowRight size={18} className="shrink-0 text-[var(--color-paper)]" />
      </button>

      {/* Реф-ссылка в главном меню — быстрый «скопировать/поделиться» без захода
          в партнёрский дашборд. Показываем, только если программа включена и
          ссылка резолвится (см. /api/cabinet snapshot → referralLink). */}
      {snapshot.referralLink && (
        <div className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]">
          <div className="flex items-center gap-2">
            <IconLink size={18} className="shrink-0 text-[var(--color-teal-light)]" />
            <span className="font-display text-sm font-bold text-[var(--text)]">
              Зови друзей — получай процент
            </span>
          </div>
          <p className="mt-1 font-body text-xs text-[var(--text-muted)]">
            Друг открывает бота по твоей ссылке и закрепляется за тобой.
          </p>
          <div className="mt-3 flex items-center rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-display text-[13px] font-bold text-[var(--color-teal-light)]">
              {snapshot.referralLink}
            </span>
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => {
                const link = snapshot.referralLink;
                if (!link) return;
                void copyToClipboard(link).then((ok) => {
                  if (ok) {
                    setRefCopied(true);
                    setTimeout(() => setRefCopied(false), 1600);
                  } else {
                    setNotice('Не удалось скопировать. Выдели ссылку выше и скопируй вручную.');
                  }
                });
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--accent)] px-3 py-2 font-display text-[13px] font-bold text-[var(--color-paper)] shadow-[2px_2px_0_var(--shadow-ink)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              {refCopied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              {refCopied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button
              type="button"
              onClick={() => {
                const link = snapshot.referralLink;
                if (!link) return;
                const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Оплачиваю иностранные подписки в рублях через Оплатишку — попробуй!')}`;
                const tg = tgRef.current;
                if (tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
                else window.open(shareUrl, '_blank');
              }}
              className="flex items-center justify-center gap-1.5 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2 font-display text-[13px] font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <IconSend size={16} />
              Поделиться
            </button>
          </div>
        </div>
      )}

      {/* Списка заказов (истории покупок) в кабинете осознанно НЕТ — решение
          владельца 2026-07-02: только действие «оплатить» + карта + партнёрка.
          К свежесозданному заказу ведёт flow каталога (view 'detail'). */}
    </main>
  );
}

function CenteredNote({ title, text }: { title?: string; text: string }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-2 p-6 text-center">
      {title && <h1 className="font-display text-xl font-bold text-[var(--text)]">{title}</h1>}
      <p className="font-body text-sm text-[var(--text-muted)]">{text}</p>
    </div>
  );
}
