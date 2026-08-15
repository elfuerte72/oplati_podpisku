'use client';

import { useState } from 'react';

import { ServiceInstructions } from '@/components/catalog/ServiceInstructions';
import { ComicButton } from '@/components/comic/ComicButton';
import { ContactCard, useContactEmail } from '@/components/contacts/ContactCard';
import { formatExpires, formatRub, formatUsd } from '@/components/comic/format';
import { IconArrowLeft, IconCheck } from '@/components/comic/icons';
import {
  PAYMENT_ISSUE_CHECKLIST,
  PAYMENT_ISSUE_LABELS,
  PAYMENT_ISSUE_TYPES,
  type PaymentIssueType,
} from '@/lib/cabinet/payment-issues';
import { showCardAlreadyOwnedNote } from '@/lib/cabinet/card-fee-note';
import { track } from '@/lib/analytics/client';
import { buyerFeeAmountNote, buyerFeeNote } from '@/lib/payments/buyer-fee';
import {
  PAYMENT_ISSUE_EVENT,
  SUBSCRIPTION_ACTIVATED_EVENT,
} from '@/lib/cabinet/types';

import { StatusBadge } from './StatusBadge';
import type { OrderDetail, PaymentIssueResult, SubscriptionPaidResult } from './cabinet-api';

export type DetailActionMessage = { tone: 'ok' | 'err'; text: string };

type Props = {
  order: OrderDetail;
  /** Есть ли у клиента активная карта (из снапшота кабинета) — НЕ выводится из fee=0 (L-22). */
  hasActiveCard: boolean;
  busy: 'pay' | null;
  message: DetailActionMessage | null;
  /** Почта из профиля (prefill плашки контактов, тикет 02). */
  savedEmail: string | null;
  onBack: () => void;
  onPay: (email?: string) => void;
  onOpenExternalLink: (url: string) => void;
  onReportIssue: (issueType: PaymentIssueType, comment?: string) => Promise<PaymentIssueResult>;
  onSubscriptionPaid: () => Promise<SubscriptionPaidResult>;
  /**
   * Уйти в поддержку из плашки ошибки. Нужен, когда счёт не выставился
   * (лежит платёжный шлюз): «попробуй позже» без выхода — тупик, из которого
   * клиент уходит насовсем. Не задан → кнопки нет, поведение прежнее.
   */
  onContactSupport?: (() => void) | undefined;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 font-body text-sm">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text)]">{value}</dd>
    </div>
  );
}

/**
 * Рублёвый «чек» заказа. `cardIssueFeeKopecks` — снимок разовой надбавки за
 * выпуск карты (уже включён в `totalKopecks`):
 *  - `> 0` — первая оплата: показываем «Подписка + Выпуск карты = Итого»;
 *  - `= 0` И у клиента есть карта — «Сумма» + заметка «карта уже есть»
 *    (L-22: fee=0 бывает и при отключённой env-надбавке — тогда заметка врала);
 *  - иначе — просто «Сумма».
 */
function RubBreakdown({
  totalKopecks,
  cardIssueFeeKopecks,
  hasActiveCard,
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
  hasActiveCard: boolean;
}) {
  if (cardIssueFeeKopecks !== null && cardIssueFeeKopecks > 0) {
    return (
      <>
        <Row label="Подписка" value={formatRub(totalKopecks - cardIssueFeeKopecks)} />
        <Row label="Выпуск карты" value={`+ ${formatRub(cardIssueFeeKopecks)}`} />
        <p className="font-body text-xs text-[var(--text-muted)]">
          разово — только для первой карты; в следующих заказах этой строки не будет
        </p>
        <div className="my-1.5 border-t-2 border-dashed border-[var(--shadow-ink)]" />
        <div className="flex justify-between gap-4 font-display text-base font-bold">
          <dt className="text-[var(--text)]">Итого к оплате</dt>
          <dd className="text-[var(--text)]">{formatRub(totalKopecks)}</dd>
        </div>
      </>
    );
  }
  if (showCardAlreadyOwnedNote(cardIssueFeeKopecks, hasActiveCard)) {
    return (
      <>
        <Row label="Сумма" value={formatRub(totalKopecks)} />
        <div className="flex items-center gap-1.5 pt-0.5 font-body text-xs text-[var(--success)]">
          <IconCheck size={14} className="shrink-0" />
          <span>Карта уже есть — платишь только за подписку</span>
        </div>
      </>
    );
  }
  return <Row label="Сумма" value={formatRub(totalKopecks)} />;
}

/**
 * Полная разбивка цены: сверху — оригинальная цена подписки в долларах (столько
 * клиент вводит на сайте сервиса, по цене США), под чертой — рублёвый чек с
 * подсчётами (сколько списываем у нас). `originalAmountUsdCents` уже приходит с
 * бэкенда (`OrderDetail.originalAmount`); `null`/0 — заказ до фичи, показываем
 * только рублёвый чек.
 */
function PriceBreakdown({
  totalKopecks,
  cardIssueFeeKopecks,
  originalAmountUsdCents,
  hasActiveCard,
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
  originalAmountUsdCents: number | null;
  hasActiveCard: boolean;
}) {
  return (
    <>
      {originalAmountUsdCents !== null && originalAmountUsdCents > 0 && (
        <>
          <div className="flex justify-between gap-4 font-body text-sm">
            <dt className="text-[var(--text-muted)]">Цена подписки</dt>
            <dd className="font-display font-bold text-[var(--text)]">
              {formatUsd(originalAmountUsdCents)}
            </dd>
          </div>
          <p className="font-body text-xs text-[var(--text-muted)]">
            столько вводишь на сайте сервиса — в долларах, по цене США
          </p>
          <div className="my-1.5 border-t-2 border-dashed border-[var(--shadow-ink)]" />
        </>
      )}
      <RubBreakdown
        totalKopecks={totalKopecks}
        cardIssueFeeKopecks={cardIssueFeeKopecks}
        hasActiveCard={hasActiveCard}
      />
    </>
  );
}

/**
 * Раскрывающийся блок «Как рассчитана сумма» (ТЗ §3): из чего сложился итог —
 * цена подписки, зафиксированный курс, комиссия сервиса, разовый выпуск карты.
 */
function HowPriceComputed({
  order,
  hasActiveCard,
}: {
  order: OrderDetail;
  hasActiveCard: boolean;
}) {
  // Курс хранится как rate × 10000 (см. orders.usdt_rub_rate_kopecks в схеме).
  const rate =
    order.usdtRubRateKopecks !== null && order.usdtRubRateKopecks > 0
      ? (order.usdtRubRateKopecks / 10000).toFixed(2)
      : null;
  // USD-строки — только для долларовых заказов (как в PriceBreakdown): formatUsd
  // жёстко ставит $, для иной валюты это был бы неверный ярлык.
  const usdAmount =
    order.originalCurrency === 'USD' && order.originalAmount !== null && order.originalAmount > 0
      ? order.originalAmount
      : null;
  return (
    <details
      className="group mt-3 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5"
      onToggle={(e) => {
        if (e.currentTarget.open) {
          track('price_breakdown_open', { surface: 'cabinet' });
        }
      }}
    >
      <summary className="cursor-pointer list-none font-display text-sm font-bold text-[var(--text)]">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
        Как рассчитана сумма
      </summary>
      <ul className="mt-2 space-y-1 font-body text-xs leading-snug text-[var(--text-muted)]">
        {usdAmount !== null && (
          <li>
            Цена подписки — {formatUsd(usdAmount)}: столько стоит сервис в США,
            эту сумму ты вводишь на его сайте.
          </li>
        )}
        {rate && <li>Курс на момент заказа — 1 $ = {rate} ₽ (зафиксирован в заказе).</li>}
        <li>Комиссия сервиса рассчитывается системой и уже включена в итог.</li>
        {order.cardIssueFeeKopecks !== null && order.cardIssueFeeKopecks > 0 && (
          <li>
            Выпуск виртуальной карты — {formatRub(order.cardIssueFeeKopecks)} (разово, только
            для первой карты).
          </li>
        )}
        {showCardAlreadyOwnedNote(order.cardIssueFeeKopecks, hasActiveCard) && (
          <li>Выпуск карты не оплачивается — карта уже есть, платишь только за подписку.</li>
        )}
        {order.buyerFeePercent > 0 ? (
          <li>
            {buyerFeeNote(order.buyerFeePercent)} Наша сумма после создания заказа не меняется.
          </li>
        ) : (
          <li>После создания заказа сумма не меняется — платишь ровно столько, сколько видишь.</li>
        )}
      </ul>
    </details>
  );
}

/**
 * Пост-выпускной статус заказа (ТЗ §6) — выводится из append-only событий:
 * клиент отметил подписку оплаченной / сообщил о проблеме / ещё не оплатил на
 * сайте сервиса. Статус-машину заказа не трогаем — completed терминален.
 */
type AfterCardStatus = 'awaiting_site_payment' | 'subscription_paid' | 'problem';

function afterCardStatus(order: OrderDetail): AfterCardStatus {
  // Решает ПОСЛЕДНЕЕ по времени событие: «оплатил» и следом «возникла проблема»
  // должно показать проблему, а не навсегда застрять в «оплачено» (и наоборот).
  let latest: { at: string; status: AfterCardStatus } | null = null;
  for (const e of order.events) {
    const status: AfterCardStatus | null =
      e.type === SUBSCRIPTION_ACTIVATED_EVENT
        ? 'subscription_paid'
        : e.type === PAYMENT_ISSUE_EVENT
          ? 'problem'
          : null;
    if (status && (!latest || e.at >= latest.at)) {
      latest = { at: e.at, status };
    }
  }
  return latest?.status ?? 'awaiting_site_payment';
}

const AFTER_CARD_STATUS_VIEW: Record<AfterCardStatus, { label: string; className: string }> = {
  awaiting_site_payment: {
    label: 'Ожидает оплаты на сайте сервиса',
    className: 'border-[var(--color-skin)] text-[var(--text)]',
  },
  subscription_paid: {
    label: 'Подписка оплачена',
    className: 'border-[var(--success)] text-[var(--success)]',
  },
  problem: {
    label: 'Возникла проблема — разбираемся',
    className: 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
  },
};

/**
 * Блок «что дальше» для выполненного заказа: пер-сервисная инструкция, переход
 * на сайт сервиса, подтверждение оплаты подписки и «Не проходит оплата?» с
 * чек-листом и отправкой полного контекста в поддержку одним нажатием.
 */
function AfterCardBlock({
  order,
  onOpenExternalLink,
  onReportIssue,
  onSubscriptionPaid,
}: {
  order: OrderDetail;
  onOpenExternalLink: (url: string) => void;
  onReportIssue: (issueType: PaymentIssueType, comment?: string) => Promise<PaymentIssueResult>;
  onSubscriptionPaid: () => Promise<SubscriptionPaidResult>;
}) {
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueType, setIssueType] = useState<PaymentIssueType>('card_declined');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<DetailActionMessage | null>(null);

  const status = afterCardStatus(order);
  const view = AFTER_CARD_STATUS_VIEW[status];

  const sendIssue = async () => {
    if (sending) return;
    setSending(true);
    setNote(null);
    const res = await onReportIssue(issueType, comment.trim() || undefined);
    setSending(false);
    if (res.ok) {
      setIssueOpen(false);
      setNote({
        tone: 'ok',
        text: res.duplicate
          ? 'Обращение уже у оператора — он свяжется с тобой в Telegram.'
          : 'Передал оператору всё по заказу. Он напишет тебе в Telegram.',
      });
    } else {
      setNote({ tone: 'err', text: res.message });
    }
  };

  const confirmPaid = async () => {
    if (sending) return;
    setSending(true);
    setNote(null);
    const res = await onSubscriptionPaid();
    setSending(false);
    if (res.ok) {
      setNote({ tone: 'ok', text: 'Отлично! Отметил, что подписка оплачена. Пользуйся!' });
    } else {
      setNote({ tone: 'err', text: res.message });
    }
  };

  return (
    <section
      className={[
        'bg-[var(--surface)] p-5',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-base font-bold text-[var(--text)]">
          Оплата подписки на сайте
        </h3>
        <span
          className={[
            'shrink-0 rounded-full border-2 px-2.5 py-0.5 font-display text-[11px] font-bold',
            view.className,
          ].join(' ')}
        >
          {view.label}
        </span>
      </div>

      <p className="mt-2 font-body text-sm leading-snug text-[var(--text-muted)]">
        Карта выпущена и пополнена. Открой сайт сервиса, войди в свой аккаунт и введи
        реквизиты карты — реквизиты на главном экране кабинета и в Telegram.
      </p>

      <ServiceInstructions instructions={order.instructions} className="mt-3" />

      <div className="mt-3 flex flex-col gap-2">
        {order.instructions?.paymentUrl && (
          <ComicButton
            variant="primary"
            className="w-full px-4 py-2.5 text-sm"
            onClick={() => {
              const url = order.instructions?.paymentUrl;
              if (url) onOpenExternalLink(url);
            }}
          >
            Перейти на сайт сервиса
          </ComicButton>
        )}
        <ComicButton
          variant="surface"
          className="w-full px-4 py-2.5 text-sm"
          onClick={() => onOpenExternalLink(`${window.location.origin}/payment-instruction.html`)}
        >
          Инструкция по оплате
        </ComicButton>
        {status !== 'subscription_paid' && (
          <ComicButton
            variant="surface"
            className="w-full px-4 py-2.5 text-sm"
            disabled={sending}
            onClick={() => void confirmPaid()}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={16} />
              Подписка оплачена
            </span>
          </ComicButton>
        )}
        <button
          type="button"
          onClick={() => setIssueOpen((v) => !v)}
          className="font-display text-sm font-bold text-[var(--color-stamp)] underline-offset-2 hover:underline"
        >
          Не проходит оплата?
        </button>
      </div>

      {issueOpen && (
        <div className="mt-3 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] p-3.5">
          <p className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
            Сначала проверь
          </p>
          <ul className="mt-1.5 space-y-1">
            {PAYMENT_ISSUE_CHECKLIST.map((item) => (
              <li key={item} className="flex gap-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
                <span aria-hidden className="text-[var(--accent)]">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>

          <fieldset className="mt-3">
            <legend className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
              Не помогло? Что случилось:
            </legend>
            <div className="mt-1.5 space-y-1">
              {PAYMENT_ISSUE_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 font-body text-sm text-[var(--text)]">
                  <input
                    type="radio"
                    name="issue-type"
                    checked={issueType === type}
                    onChange={() => setIssueType(type)}
                    className="accent-[var(--accent)]"
                  />
                  {PAYMENT_ISSUE_LABELS[type]}
                </label>
              ))}
            </div>
          </fieldset>

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Комментарий (необязательно)"
            aria-label="Комментарий к проблеме"
            className="mt-2.5 w-full resize-none rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-body text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />

          <ComicButton
            variant="primary"
            className="mt-2 w-full px-4 py-2.5 text-sm"
            disabled={sending}
            onClick={() => void sendIssue()}
          >
            {sending ? 'Отправляю…' : 'Отправить в поддержку'}
          </ComicButton>
          <p className="mt-1.5 font-body text-[11px] leading-snug text-[var(--text-muted)]">
            Оператору автоматически уйдут номер заказа, сервис, тариф, сумма и статус карты.
          </p>
        </div>
      )}

      {note && (
        <p
          role="status"
          className={[
            'mt-3 rounded-[12px] border-2 px-3 py-2 font-body text-sm',
            note.tone === 'ok'
              ? 'border-[var(--color-teal-deep)] text-[var(--text)]'
              : 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
          ].join(' ')}
        >
          {note.text}
        </p>
      )}
    </section>
  );
}

/**
 * Экран деталей заказа: сводка, кнопка «Оплатить <сумма>» (финальная сумма — на
 * кнопке, ТЗ §3), таймлайн событий, платежи и блок «что дальше» после выпуска
 * карты. Оплата проксируется наверх в CabinetClient (там Telegram WebApp для
 * открытия платёжной ссылки).
 */
export function OrderDetailView({
  order,
  hasActiveCard,
  busy,
  message,
  savedEmail,
  onBack,
  onPay,
  onOpenExternalLink,
  onReportIssue,
  onSubscriptionPaid,
  onContactSupport,
}: Props) {
  // Плашка контактов (тикет 02): почта обязательна для выставления счёта.
  // markSaved — оптимистично при нажатии «Оплатить»: сервер сохраняет почту в
  // профиль ДО создания счёта, поэтому даже неудачная оплата её не теряет.
  const contact = useContactEmail(savedEmail);

  const handlePay = () => {
    const email = contact.emailToSend;
    if (email !== undefined) contact.markSaved(email);
    onPay(email);
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 font-display text-sm font-bold text-[var(--link)]"
      >
        <IconArrowLeft size={16} />
        В кабинет
      </button>

      <div
        className={[
          'bg-[var(--surface)] p-5',
          'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-sm font-bold text-[var(--text-muted)]">
            {order.shortId}
          </span>
          <StatusBadge status={order.status} label={order.statusLabel} />
        </div>
        <p className="mt-1 font-display text-xl font-bold text-[var(--text)]">{order.service}</p>

        <div className="my-4 border-t-2 border-[var(--shadow-ink)]" />

        <dl className="space-y-1">
          <Row label="Создан" value={formatExpires(order.createdAt)} />
          {order.amountKopecks !== null && (
            <PriceBreakdown
              totalKopecks={order.amountKopecks}
              cardIssueFeeKopecks={order.cardIssueFeeKopecks}
              hasActiveCard={hasActiveCard}
              // USD-строку показываем только для долларовых заказов: formatUsd
              // жёстко форматирует в $, для не-USD валюты это был бы неверный
              // ярлык. Сейчас каталог всегда USD — проверка защитная.
              originalAmountUsdCents={order.originalCurrency === 'USD' ? order.originalAmount : null}
            />
          )}
          {order.paidAt && <Row label="Оплачен" value={formatExpires(order.paidAt)} />}
          {order.fulfilledAt && <Row label="Выполнен" value={formatExpires(order.fulfilledAt)} />}
        </dl>

        {order.amountKopecks !== null && (
          <HowPriceComputed order={order} hasActiveCard={hasActiveCard} />
        )}

        {order.payable && (
          <div className="mt-5 space-y-3">
            <ContactCard {...contact.card} />
            <ComicButton
              variant="primary"
              onClick={handlePay}
              disabled={busy !== null || !contact.emailOk}
            >
              {busy === 'pay'
                ? 'Готовлю счёт…'
                : order.amountKopecks !== null
                  ? `Оплатить ${formatRub(order.amountKopecks)}`
                  : 'Оплатить'}
            </ComicButton>
            {order.amountKopecks !== null &&
              buyerFeeAmountNote(order.amountKopecks, order.buyerFeePercent, formatRub) !==
                null && (
                <p className="mt-2 rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text)]">
                  {buyerFeeAmountNote(order.amountKopecks, order.buyerFeePercent, formatRub)}
                </p>
              )}
            {order.expiresAt && (
              <p className="mt-2 font-body text-xs text-[var(--text-muted)]">
                Цена зафиксирована до {formatExpires(order.expiresAt)}
                {order.buyerFeePercent > 0
                  ? ' — наша сумма не изменится.'
                  : ' — после оплаты сумма не изменится.'}
              </p>
            )}
          </div>
        )}

        {message && (
          <div
            className={[
              'mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[12px] border-2 px-3 py-2',
              message.tone === 'ok'
                ? 'border-[var(--color-teal-deep)]'
                : 'border-[var(--color-stamp)]',
            ].join(' ')}
          >
            <p
              className={[
                'font-body text-sm',
                message.tone === 'ok' ? 'text-[var(--text)]' : 'text-[var(--color-stamp)]',
              ].join(' ')}
            >
              {message.text}
            </p>
            {message.tone === 'err' && onContactSupport && (
              <button
                type="button"
                onClick={onContactSupport}
                className="shrink-0 rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-2.5 py-1 font-display text-xs text-[var(--text)]"
              >
                Написать в поддержку
              </button>
            )}
          </div>
        )}
      </div>

      {/* «Что дальше» — только когда карта выпущена и заказ выполнен. */}
      {order.status === 'completed' && (
        <AfterCardBlock
          order={order}
          onOpenExternalLink={onOpenExternalLink}
          onReportIssue={onReportIssue}
          onSubscriptionPaid={onSubscriptionPaid}
        />
      )}

      {order.payments.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Платежи
          </h3>
          {order.payments.map((p) => (
            <div
              key={`${p.invoiceNumber ?? 'inv'}-${p.createdAt}`}
              className={[
                'flex items-center justify-between gap-3 bg-[var(--surface)] px-4 py-3',
                'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
              ].join(' ')}
            >
              <div>
                <p className="font-display text-base font-bold text-[var(--text)]">
                  {formatRub(p.amountKopecks)}
                </p>
                <p className="font-body text-xs text-[var(--text-muted)]">
                  {p.invoiceNumber ?? '—'} · {formatExpires(p.createdAt)}
                </p>
              </div>
              <StatusBadge status={p.status} label={p.statusLabel} />
            </div>
          ))}
        </section>
      )}

      {order.events.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
            История
          </h3>
          <ol className="space-y-2 border-l-2 border-[var(--shadow-ink)] pl-4">
            {order.events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="font-body text-sm">
                <span className="text-[var(--text)]">{e.label}</span>
                <span className="ml-2 text-[var(--text-muted)]">{formatExpires(e.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
