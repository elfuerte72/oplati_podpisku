'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  IconArrowRight,
  IconBulb,
  IconCart,
  IconCheck,
  IconCopy,
  IconLink,
  IconSend,
  IconUsers,
} from '@/components/comic/icons';
import { SITE_ORIGIN } from '@/components/info/constants';
import { PartnerCabinet } from '@/components/partner/PartnerCabinet';
import { telegramShareLink } from '@/lib/telegram/links';

import { CabinetIntro } from './CabinetIntro';
import { CabinetLoader } from './CabinetLoader';
import { loadTelegramWebApp, type TelegramWebApp } from './telegram';
import { track } from '@/lib/analytics/client';
import {
  doMarkSubscriptionPaid,
  doPay,
  doReportPaymentIssue,
  fetchCardDetails,
  fetchOrderDetail,
  fetchSnapshot,
  type OrderDetail,
  type Snapshot,
} from './cabinet-api';
import type { PaymentIssueType } from '@/lib/cabinet/payment-issues';
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
  // Основной путь — Clipboard API. Reject (в Telegram WebView он часто
  // заблокирован) обрабатываем вторым коллбэком .then, без bare catch — при
  // неудаче падаем на execCommand ниже.
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
  } catch {
    return false;
  }
}

const CABINET_INTRO_KEY = 'oplatishka_cabinet_intro_seen';
const noopSubscribe = () => () => {};

/**
 * «Видел ли клиент онбординг кабинета» как external store (localStorage): на
 * сервере считаем «видел» (не рендерим — нет hydration mismatch), на клиенте
 * читаем флаг. Отдельный ключ от веб-интро — это другой контекст (кнопочный
 * кабинет, а не чат), веб-флаг переиспользовать нельзя.
 */
function useCabinetIntroSeen(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        return window.localStorage.getItem(CABINET_INTRO_KEY) !== null;
      } catch {
        // приватный режим без localStorage — интро просто не показываем
        return true;
      }
    },
    () => true,
  );
}

export function CabinetClient({ previewSnapshot }: { previewSnapshot?: Snapshot } = {}) {
  const [phase, setPhase] = useState<Phase>(previewSnapshot ? 'ready' : 'loading');
  const [errorText, setErrorText] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(previewSnapshot ?? null);
  const [view, setView] = useState<'list' | 'detail' | 'referral' | 'catalog'>('list');
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<'pay' | null>(null);
  const [actionMsg, setActionMsg] = useState<DetailActionMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Реквизиты карты, показанные по кнопке (живой fetch, не хранятся). Сбрасываются
  // при уходе с экрана списка — чтобы не висели открытыми.
  const [cardDetails, setCardDetails] = useState<CardDetails | null>(null);
  const [revealingCard, setRevealingCard] = useState(false);
  const [refCopied, setRefCopied] = useState(false);

  // Онбординг кабинета: показ при первом входе (флаг в localStorage) + повтор из
  // шапки; после первого закрытия разово подсвечиваем «Выбрать сервис».
  const introSeen = useCabinetIntroSeen();
  const [introDismissed, setIntroDismissed] = useState(false);
  const [forceIntro, setForceIntro] = useState(false);
  const [highlightCatalog, setHighlightCatalog] = useState(false);

  const tgRef = useRef<TelegramWebApp | null>(null);
  const initDataRef = useRef<string>('');
  // initData в state (а не только в ref) — нужно при рендере секции «Партнёрам»
  // (PartnerCabinet получает initData как проп; ref читать в рендере нельзя).
  const [initData, setInitData] = useState('');
  // Умеет ли клиент Telegram закрывать Mini App. В state, а не через
  // `tgRef.current` в рендере: ref читать при рендере нельзя (и он всё равно
  // пуст на первом проходе — кнопка не появилась бы после загрузки SDK).
  const [canCloseApp, setCanCloseApp] = useState(false);

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
      setCanCloseApp(typeof tg.close === 'function');
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

  // Открытие кабинета. Ref-гейт: StrictMode монтирует эффекты дважды, а два
  // «открыл кабинет» на один вход исказили бы всю статистику Mini App.
  const cabinetOpenSentRef = useRef(false);
  useEffect(() => {
    if (cabinetOpenSentRef.current || !snapshot) return;
    cabinetOpenSentRef.current = true;
    track('cabinet_open', { entry: previewSnapshot ? 'preview' : 'telegram' });
  }, [snapshot, previewSnapshot]);

  const reloadSnapshot = useCallback(async () => {
    const res = await fetchSnapshot(initDataRef.current);
    if (res.ok) setSnapshot(res.data);
  }, []);

  const openExternalLink = useCallback((url: string) => {
    const tg = tgRef.current;
    if (tg) tg.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const revealCard = useCallback(async (cardId: string) => {
    setRevealingCard(true);
    const res = await fetchCardDetails(initDataRef.current, cardId);
    setRevealingCard(false);
    if (res.ok) {
      // Только факт показа. Ни PAN, ни CVC в телеметрию не попадают никогда —
      // маска номера тоже не нужна, `card_last4` берём из снапшота выше по UI.
      track('card_details_view');
      setCardDetails({ number: res.number, exp: res.exp, cvc: res.cvc });
    } else {
      setNotice('Не удалось показать реквизиты. Попробуй ещё раз.');
    }
  }, []);

  const hideCard = useCallback(() => setCardDetails(null), []);

  // Автоскрытие реквизитов (ТЗ §4): показанные номер/CVC сами прячутся через
  // минуту — чтобы не висели открытыми на экране в транспорте/на людях.
  useEffect(() => {
    if (!cardDetails) return;
    const timer = window.setTimeout(() => setCardDetails(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [cardDetails]);

  // Заказ, открытый на экране детали прямо сейчас: ответы отставших запросов
  // (клиент успел уйти или открыть другой заказ) не должны перезаписать detail.
  const activeOrderIdRef = useRef<string | null>(null);

  const openOrder = useCallback(async (orderId: string) => {
    setActionMsg(null);
    setNotice(null);
    setCardDetails(null); // прячем реквизиты при уходе со списка
    setDetailLoading(true);
    setView('detail');
    setDetail(null);
    activeOrderIdRef.current = orderId;
    const res = await fetchOrderDetail(initDataRef.current, orderId);
    if (activeOrderIdRef.current !== orderId) return; // уже смотрим другой заказ
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
    if (res.ok && activeOrderIdRef.current === orderId) setDetail(res.data);
  }, []);

  // «Не проходит оплата?» из детали заказа: контекст (заказ/сервис/тариф/сумма/
  // статус карты) собирает сервер; после отправки перечитываем деталь, чтобы
  // показать статус «Возникла проблема».
  const reportIssue = useCallback(
    async (issueType: PaymentIssueType, comment?: string) => {
      if (!detail) {
        return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
      }
      const res = await doReportPaymentIssue(initDataRef.current, detail.orderId, issueType, comment);
      if (res.ok) void refreshDetail(detail.orderId);
      return res;
    },
    [detail, refreshDetail],
  );

  // «Подписка оплачена» — фиксируем подтверждение клиента и обновляем деталь.
  const confirmSubscriptionPaid = useCallback(async () => {
    if (!detail) {
      return { ok: false as const, error: 'no_order', message: 'Заказ не открыт.' };
    }
    const res = await doMarkSubscriptionPaid(initDataRef.current, detail.orderId);
    if (res.ok) void refreshDetail(detail.orderId);
    return res;
  }, [detail, refreshDetail]);

  const onPay = useCallback(async () => {
    if (!detail) return;
    setBusy('pay');
    setActionMsg(null);
    const res = await doPay(initDataRef.current, detail.orderId);
    setBusy(null);
    if (res.ok) {
      setActionMsg({ tone: 'ok', text: 'Счёт готов — открываю оплату.' });
      track(
        'pay_link_click',
        { surface: 'cabinet' },
        // shortId (ORD-...), а НЕ orderId: UUID длиннее лимита схемы приёма —
        // событие вместе со всем батчем отбивалось бы как invalid_body.
        { orderRef: detail.shortId, immediate: true },
      );
      const tg = tgRef.current;
      if (tg) tg.openLink(res.paymentUrl);
      else window.open(res.paymentUrl, '_blank');
      void refreshDetail(detail.orderId);
      void reloadSnapshot();
    } else {
      setActionMsg({ tone: 'err', text: res.message });
    }
  }, [detail, refreshDetail, reloadSnapshot]);

  // Выход в поддержку из плашки ошибки: закрываем Mini App — пользователь
  // оказывается в чате бота, где работает /support. Своего канала связи у
  // кабинета нет, а оставлять клиента с «попробуй позже» без выхода нельзя.
  const contactSupport = useCallback(() => {
    tgRef.current?.close?.();
  }, []);

  // Тактильный отклик онбординга (необязателен — только в новых клиентах TG).
  const introHaptic = useCallback((kind: 'tick' | 'success') => {
    const h = tgRef.current?.HapticFeedback;
    try {
      if (kind === 'success') h?.notificationOccurred?.('success');
      else h?.impactOccurred?.('light');
    } catch {
      // тактилка не критична — молча пропускаем
    }
  }, []);

  // Первый показ — когда флаг не стоял и его не открыли повторно из шапки.
  const introFirstRun = !introSeen && !forceIntro;
  const closeIntro = useCallback(() => {
    try {
      window.localStorage.setItem(CABINET_INTRO_KEY, '1');
    } catch {
      // не записалось — покажем ещё раз в следующий визит, не критично
    }
    setIntroDismissed(true);
    setForceIntro(false);
    // Только на первом показе подсвечиваем реальную кнопку «Выбрать сервис» —
    // прямо отвечаем на «куда нажимать». Повтор из шапки подсветку не запускает.
    if (introFirstRun) {
      setHighlightCatalog(true);
      window.setTimeout(() => setHighlightCatalog(false), 3600);
    }
  }, [introFirstRun]);

  const showIntro = phase === 'ready' && !!snapshot && (forceIntro || (!introSeen && !introDismissed));

  // ─── Рендер ──────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return <CabinetLoader />;
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
          // Факт наличия карты — из снапшота, НЕ из fee=0 заказа (L-22): на
          // dev/preview надбавка отключена env'ом и fee=0 у всех без карты.
          hasActiveCard={snapshot.cards.some((c) => c.status === 'active')}
          busy={busy}
          message={actionMsg}
          onBack={() => {
            activeOrderIdRef.current = null;
            setView('list');
            setDetail(null);
            setActionMsg(null);
            void reloadSnapshot();
          }}
          onPay={onPay}
          onOpenExternalLink={openExternalLink}
          onReportIssue={reportIssue}
          onSubscriptionPaid={confirmSubscriptionPaid}
          // Закрываем Mini App — пользователь оказывается в чате бота, где
          // работает /support. Своего канала связи у кабинета нет, а оставлять
          // клиента с «попробуй позже» и без выхода нельзя. Старый клиент
          // Telegram без close() → кнопку не показываем.
          onContactSupport={canCloseApp ? contactSupport : undefined}
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
          onOpenExternalLink={openExternalLink}
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
  // Заказ карты для «Не проходит оплата?» — сузили в переменную, чтобы замыкание
  // держало string, а не nullable-поле.
  const issueOrderId = primaryCard?.purposeOrderId ?? null;

  return (
    <>
    <main className="mx-auto w-full max-w-md space-y-4 p-4">
      {/* Компактная шапка вместо громоздкого ProfileHeader. */}
      <header className="flex items-center gap-3 pt-1">
        <Mascot pose="idle" size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-body text-xs text-[var(--text-muted)]">Личный кабинет</p>
          <h1 className="truncate font-display text-xl font-bold text-[var(--text)]">{greeting}</h1>
        </div>
        {/* Реплей онбординга — для тех, кто «не понял, как это работает». */}
        <button
          type="button"
          onClick={() => setForceIntro(true)}
          aria-label="Как это работает"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-1.5 font-display text-xs font-bold text-[var(--text-muted)] shadow-[2px_2px_0_var(--shadow-ink)] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-none"
        >
          <IconBulb size={16} />
          Как это работает
        </button>
      </header>

      {notice && (
        <p className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
          {notice}
        </p>
      )}

      {/* Главное действие кабинета — оплатить подписку через кнопочный каталог. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setHighlightCatalog(false);
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
        {highlightCatalog && (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-1 rounded-[calc(var(--radius-card)+4px)] border-[3px] border-[var(--color-teal-light)] motion-safe:animate-[spotlight-pulse_1.1s_ease-in-out_infinite]"
          />
        )}
      </div>

      {/* Карта клиента — главный акцент. */}
      <CardHero
        card={primaryCard}
        details={cardDetails}
        revealing={revealingCard}
        onReveal={primaryCard ? () => revealCard(primaryCard.id) : undefined}
        onHide={hideCard}
        onOpenExternalLink={openExternalLink}
        onOpenIssueOrder={issueOrderId ? () => void openOrder(issueOrderId) : undefined}
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
                track('referral_link_share', { action: 'copy', surface: 'cabinet_home' });
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
                track('referral_link_share', { action: 'share', surface: 'cabinet_home' });
                const shareUrl = telegramShareLink(
                  link,
                  'Оплачиваю иностранные подписки в рублях через Оплатишку — попробуй!',
                );
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

      {/* Документы и контакты — те же публичные страницы сайта (требование
          платёжного провайдера). Абсолютные ссылки: кабинет живёт на другом
          хосте; открываем внешним браузером через tg.openLink. */}
      <nav
        aria-label="Документы и контакты"
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-2 pt-1 font-body text-xs text-[var(--text-muted)]"
      >
        {[
          { href: `${SITE_ORIGIN}/about`, label: 'О сервисе' },
          { href: `${SITE_ORIGIN}/terms`, label: 'Условия' },
          { href: `${SITE_ORIGIN}/privacy`, label: 'Конфиденциальность' },
        ].map((doc, i) => (
          <span key={doc.href} className="inline-flex items-center gap-x-3">
            {i > 0 && <span aria-hidden>·</span>}
            <button
              type="button"
              onClick={() => openExternalLink(doc.href)}
              className="underline transition-colors active:text-[var(--text)]"
            >
              {doc.label}
            </button>
          </span>
        ))}
      </nav>
    </main>
    {showIntro && <CabinetIntro onClose={closeIntro} haptic={introHaptic} />}
    </>
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
