'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatRub } from '@/components/comic/format';

import { loadTelegramWebApp, type TelegramWebApp } from './telegram';
import {
  doOperator,
  doPay,
  doRepeat,
  fetchOrderDetail,
  fetchSnapshot,
  type OrderDetail,
  type Snapshot,
} from './cabinet-api';
import { ProfileHeader } from './ProfileHeader';
import { OrderRow } from './OrderRow';
import { CardsSection } from './CardsSection';
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

export function CabinetClient() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorText, setErrorText] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<'pay' | 'repeat' | 'operator' | null>(null);
  const [actionMsg, setActionMsg] = useState<DetailActionMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tgRef = useRef<TelegramWebApp | null>(null);
  const initDataRef = useRef<string>('');

  // ─── Инициализация: SDK Telegram → snapshot ──────────────────────────────
  useEffect(() => {
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
      try {
        tg.ready();
        tg.expand();
        if (tg.colorScheme === 'light' || tg.colorScheme === 'dark') {
          document.documentElement.dataset.theme = tg.colorScheme;
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
  }, []);

  const reloadSnapshot = useCallback(async () => {
    const res = await fetchSnapshot(initDataRef.current);
    if (res.ok) setSnapshot(res.data);
  }, []);

  const openOrder = useCallback(async (orderId: string) => {
    setActionMsg(null);
    setNotice(null);
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

  return (
    <main className="mx-auto w-full max-w-md space-y-5 p-4">
      <ProfileHeader profile={snapshot.profile} />

      {notice && (
        <p className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
          {notice}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
          Заказы
        </h2>
        {snapshot.orders.length === 0 ? (
          <p className="font-body text-sm text-[var(--text-muted)]">
            Здесь появятся твои заказы. Напиши боту, что хочешь оплатить — и Оплатишка всё оформит.
          </p>
        ) : (
          snapshot.orders.map((order) => (
            <OrderRow key={order.orderId} order={order} onOpen={openOrder} />
          ))
        )}
      </section>

      <CardsSection cards={snapshot.cards} />
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
