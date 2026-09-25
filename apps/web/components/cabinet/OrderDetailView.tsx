'use client';

import { useRef, useState } from 'react';

import { PROMO_CODE_MAX_LENGTH } from '@oplati/types';

import { ServiceInstructions } from '@/components/catalog/ServiceInstructions';
import { ComicButton } from '@/components/comic/ComicButton';
import { ContactCard, useContacts } from '@/components/contacts/ContactCard';
import { SITE_ORIGIN } from '@/components/info/constants';
import { isPhoneRequiredForAmount } from '@/lib/contacts/phone';
import { formatExpires, formatRub, formatUsd } from '@/components/comic/format';
import { IconCheck } from '@/components/comic/icons';
import {
  PAYMENT_PROBLEM_LABELS,
  PAYMENT_PROBLEM_TYPES,
  type PaymentIssueType,
  type PaymentProblemType,
} from '@/lib/cabinet/payment-issues';
import { showCardAlreadyOwnedNote } from '@/lib/cabinet/card-fee-note';
import { ISSUE_FAILED_TEXT, isPaidButIssueFailed } from '@/lib/cabinet/issue-failed';
import { buildPathSteps, siteHostFromUrl, type PathStage } from '@/lib/cabinet/path-steps';
import { PAY_BLOCK_TEXT, payBlockReason, type PayBlockReason } from '@/lib/cabinet/pay-block';
import { track } from '@/lib/analytics/client';
import { buyerFeeAmountNote, buyerFeeNote } from '@/lib/payments/buyer-fee';
import {
  PAYMENT_ISSUE_EVENT,
  SUBSCRIPTION_ACTIVATED_EVENT,
} from '@/lib/cabinet/types';

import { PathSteps } from './PathSteps';
import { PaymentIssueForm, paymentIssueSentText } from './PaymentIssueForm';
import { StatusBadge } from './StatusBadge';
import type { TelegramMainButton } from './telegram';
import { useMainButton } from './use-main-button';
import type {
  CancelOrderResult,
  OrderDetail,
  PaymentIssueResult,
  PaymentProblemResult,
  PromoCheckResult,
  SubscriptionPaidResult,
} from './cabinet-api';

export type DetailActionMessage = { tone: 'ok' | 'err'; text: string };

type Props = {
  order: OrderDetail;
  /** Есть ли у клиента активная карта (из снапшота кабинета) — НЕ выводится из fee=0 (L-22). */
  hasActiveCard: boolean;
  busy: 'pay' | null;
  message: DetailActionMessage | null;
  /** Контакты из профиля (prefill плашки, тикеты 02/05). */
  savedEmail: string | null;
  savedPhone: string | null;
  phoneSource: string | null;
  /** Порог «телефон обязателен» в целых рублях; null — фича выключена. */
  phoneRequiredFromRub: number | null;
  /**
   * Клиент ушёл на страницу оплаты, и лист ждёт подтверждения (трек
   * miniapp-tabs, тикет 08): опрос статуса идёт в `CabinetClient`.
   */
  awaitingPayment?: boolean;
  /**
   * Нативная кнопка Telegram для «Оплатить» (тикет 05). `null` — её нет
   * (старый клиент, стенд): лист рисует свою кнопку в закреплённом низу.
   */
  mainButton?: TelegramMainButton | null;
  onPay: (
    contactsToSend: { email?: string; phone?: string },
    useBonus: boolean,
    /** Промокод, применённый на экране; undefined — его нет (трек promo-codes). */
    promoCode?: string,
  ) => void;
  /** Проверить промокод по этому заказу. Ничего не занимает — только считает. */
  onCheckPromo: (code: string) => Promise<PromoCheckResult>;
  /** «Взять из Telegram» (requestContact SDK); не задан → кнопки нет. */
  onRequestTelegramPhone?: (() => void) | undefined;
  onOpenExternalLink: (url: string) => void;
  onReportIssue: (issueType: PaymentIssueType, comment?: string) => Promise<PaymentIssueResult>;
  /** «Проблема с оплатой» — фаза ДО выпуска карты (тикет 10). */
  onReportPaymentProblem: (
    problemType: PaymentProblemType,
    comment?: string,
  ) => Promise<PaymentProblemResult>;
  onSubscriptionPaid: () => Promise<SubscriptionPaidResult>;
  /**
   * «Отменить заказ» — клиент передумал платить. Возвращает результат, а уводит
   * с экрана родитель: после отмены заказ перестаёт быть оплатимым, и оставлять
   * клиента на экране с кнопкой «Оплатить» нельзя.
   */
  onCancel: () => Promise<CancelOrderResult>;
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
  paid,
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
  hasActiveCard: boolean;
  /** Заказ оплачен: итог — факт («Оплачено»), а не приглашение «к оплате». */
  paid: boolean;
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
          <dt className="text-[var(--text)]">{paid ? 'Оплачено' : 'Итого к оплате'}</dt>
          <dd className="text-[var(--text)]">{formatRub(totalKopecks)}</dd>
        </div>
      </>
    );
  }
  if (showCardAlreadyOwnedNote(cardIssueFeeKopecks, hasActiveCard)) {
    return (
      <>
        <Row label={paid ? 'Оплачено' : 'Сумма'} value={formatRub(totalKopecks)} />
        <div className="flex items-center gap-1.5 pt-0.5 font-body text-xs text-[var(--success)]">
          <IconCheck size={14} className="shrink-0" />
          <span>Карта уже есть — платишь только за подписку</span>
        </div>
      </>
    );
  }
  return <Row label={paid ? 'Оплачено' : 'Сумма'} value={formatRub(totalKopecks)} />;
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
  paid,
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
  originalAmountUsdCents: number | null;
  hasActiveCard: boolean;
  paid: boolean;
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
            столько сервис спишет с виртуальной карты — в долларах, по цене США
          </p>
          <div className="my-1.5 border-t-2 border-dashed border-[var(--shadow-ink)]" />
        </>
      )}
      <RubBreakdown
        totalKopecks={totalKopecks}
        cardIssueFeeKopecks={cardIssueFeeKopecks}
        hasActiveCard={hasActiveCard}
        paid={paid}
      />
    </>
  );
}

/**
 * Блок реферальных баллов на экране заказа (трек referral-balance-spend, §8).
 *
 * Показывается ВСЕГДА, когда баланс больше нуля, и различает три состояния:
 *
 *  1. **есть что списать** — переключатель (выключен по умолчанию: списание
 *     осознанное) и разбивка «Итого · баллами · к оплате»;
 *  2. **баланс больше потолка** — то же плюс объяснение, почему списалось
 *     меньше, чем есть. Число берётся ИЗ РАСЧЁТА, а не зашивается в текст:
 *     потолок = наша комиссия по этому заказу и у каждого заказа свой;
 *  3. **баллов меньше минимума** — «баллы копятся», без переключателя. Партнёру
 *     с маленьким балансом важно видеть, что программа работает (Q16).
 *
 * Клиенту это «баллы», в кабинете партнёра доллары остаются — в коде и БД
 * сущность называется `redemption`/`bonus`.
 */
function BonusSpendBlock({
  bonus,
  enabled,
  onToggle,
  totalKopecks,
  disabled,
}: {
  bonus: NonNullable<OrderDetail['bonusOffer']>;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  totalKopecks: number;
  disabled: boolean;
}) {
  const { offer } = bonus;

  if (!offer) {
    return (
      <div className="rounded-[12px] border-2 border-dashed border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
        <p className="font-body text-xs leading-snug text-[var(--text-muted)]">
          Баллы копятся: {formatRub(bonus.balanceKopecks)} — списать можно от{' '}
          {formatUsd(bonus.minSpendUsdCents)}.
        </p>
      </div>
    );
  }

  const balanceAboveCap = bonus.balanceKopecks > offer.discountKopecks;

  return (
    <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onToggle(e.currentTarget.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-teal-deep)]"
        />
        <span className="font-display text-sm font-bold text-[var(--text)]">
          Списать баллы — {formatRub(offer.discountKopecks)}
        </span>
      </label>

      {enabled && (
        <dl className="mt-2 space-y-1 border-t-2 border-dashed border-[var(--shadow-ink)] pt-2">
          <Row label="Итого" value={formatRub(totalKopecks)} />
          <Row label="Баллами" value={`− ${formatRub(offer.discountKopecks)}`} />
          <div className="flex justify-between gap-4 font-display text-base font-bold">
            <dt className="text-[var(--text)]">К оплате</dt>
            <dd className="text-[var(--text)]">{formatRub(totalKopecks - offer.discountKopecks)}</dd>
          </div>
        </dl>
      )}

      {balanceAboveCap && (
        <p className="mt-2 font-body text-xs leading-snug text-[var(--text-muted)]">
          На балансе {formatRub(bonus.balanceKopecks)}, но по этому заказу списываем не больше нашей
          комиссии — {formatRub(offer.discountKopecks)}. Остальное останется на балансе.
        </p>
      )}
    </div>
  );
}

/**
 * Поле ввода промокода на экране заказа (трек promo-codes).
 *
 * Три состояния:
 *  1. **свёрнуто** — строка-ссылка «Есть промокод?». Поле, развёрнутое всегда,
 *     подсказывало бы каждому клиенту, что где-то есть скидка, которой у него
 *     нет, — и отправляло бы его искать код вместо оплаты;
 *  2. **ввод** — поле + «Применить», под ним текст отказа, если код не подошёл;
 *  3. **применён** — сумма скидки и кнопка снять.
 *
 * ⚠️ Применение здесь — только ОБЕЩАНИЕ. Активацию занимает сервер в момент
 * оплаты, под локами и с перепроверкой лимитов: клиент, который ввёл код и
 * передумал платить, не должен уносить с собой израсходованную активацию.
 * Поэтому же отказ возможен и позже, на кнопке «Оплатить».
 */
function PromoCodeBlock({
  applied,
  onApply,
  onClear,
  busy,
  disabled,
}: {
  applied: { code: string; discountKopecks: number; capped: boolean } | null;
  onApply: (code: string) => Promise<string | null>;
  onClear: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (applied) {
    return (
      <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-sm font-bold text-[var(--text)]">
              Промокод {applied.code} — {formatRub(applied.discountKopecks)}
            </p>
            {applied.capped && (
              <p className="mt-1 font-body text-xs leading-snug text-[var(--text-muted)]">
                По этому заказу скидка меньше номинала — больше на него не положить.
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onClear();
              setValue('');
              setError(null);
              setOpen(false);
            }}
            className="shrink-0 font-display text-xs font-bold text-[var(--link)] disabled:opacity-50"
          >
            Убрать
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-9 self-start font-body text-sm text-[var(--accent)]"
      >
        Есть промокод?
      </button>
    );
  }

  const submit = async () => {
    const code = value.trim();
    if (code.length === 0) return;
    setError(await onApply(code));
  };

  return (
    <div className="rounded-[12px] border-2 border-dashed border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          disabled={disabled || busy}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            setError(null);
          }}
          // Enter в поле — привычный способ применить код; без него клиент на
          // телефоне жмёт «готово» на клавиатуре и не понимает, почему ничего
          // не произошло.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Промокод"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={PROMO_CODE_MAX_LENGTH}
          className={[
            'min-w-0 flex-1 rounded-[8px] border-2 border-[var(--shadow-ink)] bg-[var(--surface)]',
            'px-2.5 py-1.5 font-body text-sm text-[var(--text)] uppercase',
            'placeholder:normal-case placeholder:text-[var(--text-muted)]',
          ].join(' ')}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || busy || value.trim().length === 0}
          className="shrink-0 font-display text-xs font-bold text-[var(--link)] disabled:opacity-50"
        >
          {busy ? 'Проверяю…' : 'Применить'}
        </button>
      </div>
      {error && (
        <p className="mt-2 font-body text-xs leading-snug text-[var(--text-muted)]">{error}</p>
      )}
    </div>
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
      className="group mt-1.5"
      onToggle={(e) => {
        if (e.currentTarget.open) {
          track('price_breakdown_open', { surface: 'cabinet' });
        }
      }}
    >
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 font-body text-sm text-[var(--accent)] [&::-webkit-details-marker]:hidden">
        Как рассчитана сумма
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
      </summary>
      <ul className="mt-1 space-y-1 rounded-[12px] bg-[var(--surface-2)] px-3.5 py-2.5 font-body text-xs leading-snug text-[var(--text-muted)]">
        {usdAmount !== null && (
          <li>
            Цена подписки — {formatUsd(usdAmount)}: столько стоит сервис в США,
            столько он и спишет с виртуальной карты.
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
    // Не «ожидает оплаты»: так же называется неоплаченный заказ («Ждёт
    // оплаты»), а здесь речь о шаге, который клиент делает сам на сайте.
    label: 'Осталось оплатить подписку',
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
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<DetailActionMessage | null>(null);

  const status = afterCardStatus(order);
  const view = AFTER_CARD_STATUS_VIEW[status];

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
        Карта выпущена и пополнена. Последний шаг делаешь ты: открой сайт сервиса, войди в
        свой аккаунт, оформи подписку и заплати этой картой. Номер, срок, CVC и адрес
        плательщика — во вкладке «Карта» и в сообщении бота.
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
        {/* Нейтральным цветом (находка П15): красный — только у отказа, а
            здесь клиент просит помощи. */}
        <button
          type="button"
          onClick={() => setIssueOpen((v) => !v)}
          className="min-h-10 font-body text-sm text-[var(--text-muted)] underline underline-offset-[3px]"
        >
          Не проходит оплата?
        </button>
      </div>

      {issueOpen && (
        <div className="mt-3">
          <PaymentIssueForm
            onReport={onReportIssue}
            onSent={(duplicate) => {
              setIssueOpen(false);
              setNote({ tone: 'ok', text: paymentIssueSentText(duplicate) });
            }}
            onError={(message) => setNote({ tone: 'err', text: message })}
          />
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
 * Видимость кнопки «Проблема с оплатой» (тикет 10): ждёт оплаты / на проверке /
 * СВЕЖИЙ истёкший. 48 часов — зеркало серверного окна в `reportPaymentProblem`
 * (сервер всё равно отвергнет несвежий, здесь только UX без мёртвой кнопки).
 */
const PAYMENT_PROBLEM_EXPIRED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function showPaymentProblemButton(order: OrderDetail): boolean {
  if (order.status === 'pending_payment' || order.status === 'payment_review') return true;
  if (order.status !== 'expired' || !order.expiresAt) return false;
  return Date.now() - new Date(order.expiresAt).getTime() <= PAYMENT_PROBLEM_EXPIRED_MAX_AGE_MS;
}

/**
 * «Проблема с оплатой» — фаза ДО выпуска карты (тикет 10): клиент сам зовёт
 * человека, не разыскивая поддержку. Три пункта; «я оплатил» переводит заказ
 * «на проверку» (сервер), возврат — только руками оператора.
 */
function PaymentProblemBlock({
  onReport,
}: {
  onReport: (problemType: PaymentProblemType, comment?: string) => Promise<PaymentProblemResult>;
}) {
  const [open, setOpen] = useState(false);
  const [problemType, setProblemType] = useState<PaymentProblemType>('not_confirmed');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<DetailActionMessage | null>(null);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setNote(null);
    const res = await onReport(problemType, comment.trim() || undefined);
    setSending(false);
    if (res.ok) {
      setOpen(false);
      setNote({
        tone: 'ok',
        text: res.duplicate ? 'Обращение уже у оператора — он на связи в Telegram.' : res.text,
      });
    } else {
      setNote({ tone: 'err', text: res.message });
    }
  };

  return (
    <div>
      {/* Нейтральным цветом (находка П15): красный остаётся только у
          подтверждения отмены — здесь клиент просит помощи, а не отказывается. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="min-h-10 font-body text-sm text-[var(--text-muted)] underline underline-offset-[3px]"
      >
        Проблема с оплатой?
      </button>

      {open && (
        <div className="mt-3 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] p-3.5">
          <fieldset>
            <legend className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
              Что случилось:
            </legend>
            <div className="mt-1.5 space-y-1">
              {PAYMENT_PROBLEM_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 font-body text-sm text-[var(--text)]">
                  <input
                    type="radio"
                    name="payment-problem-type"
                    checked={problemType === type}
                    onChange={() => setProblemType(type)}
                    className="accent-[var(--accent)]"
                  />
                  {PAYMENT_PROBLEM_LABELS[type]}
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
            onClick={() => void send()}
          >
            {sending ? 'Отправляю…' : 'Отправить оператору'}
          </ComicButton>
          <p className="mt-1.5 font-body text-[11px] leading-snug text-[var(--text-muted)]">
            Оператору уйдут номер заказа, сумма и статус платежа у платёжной системы.
            Возврат возможен, пока карта по заказу не выпущена.
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
    </div>
  );
}

/**
 * «Отменить заказ» — клиент выбрал сервис и передумал платить.
 *
 * Подтверждение в два шага и вопрос ставится ПРЯМО («если уже оплатил — не
 * отменяй»): сервер перед отменой спрашивает шлюз, но ссылку счёта закрыть не
 * может (API отмены инвойса у провайдеров нет) — оплата по ней после отмены
 * означает ручной возврат. Барьер тут дешевле разбора.
 *
 * Кнопка стоит под «Оплатить» в закреплённом низу листа. С вкладками (трек
 * miniapp-tabs, тикет 05, находка П15) она нейтрального цвета и подчёркнута —
 * читается как действие, но не спорит с «Оплатить»; цветом отказа
 * (`--color-stamp`) красится только подтверждение «Да, отменить».
 */
function CancelOrderBlock({
  invoiceIssued,
  payInFlight,
  onCancel,
}: {
  invoiceIssued: boolean;
  /**
   * Идёт выставление счёта («Готовлю счёт…»). Отмену в этот момент не даём:
   * счёт рождается прямо сейчас, и отмена гонялась бы с его созданием — заказ
   * ушёл бы в `cancelled` при живом платеже (или уронил бы `payments/create`
   * запрещённым переходом, оставив осиротевший счёт у шлюза).
   */
  payInFlight: boolean;
  onCancel: () => Promise<CancelOrderResult>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const confirm = async () => {
    if (sending) return;
    setSending(true);
    setErrorText(null);
    const res = await onCancel();
    // При успехе экран заказа закрывает родитель (уводит в список), поэтому
    // сбрасываем только состояние отказа: «отменяю…» должно гореть до ухода.
    if (res.ok) return;
    setSending(false);
    setConfirming(false);
    setErrorText(res.message);
  };

  return (
    <div className="flex flex-col items-center">
      {!confirming && (
        <button
          type="button"
          disabled={payInFlight}
          onClick={() => {
            setErrorText(null);
            setConfirming(true);
          }}
          className="flex min-h-11 items-center font-body text-sm text-[var(--text-muted)] underline underline-offset-[3px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Отменить заказ
        </button>
      )}

      {confirming && (
        <div className="w-full space-y-2.5 pt-1">
          <p className="font-body text-sm leading-snug text-[var(--color-stamp)]">
            {invoiceIssued
              ? 'Счёт уже выставлен. Если ты его оплатил — не отменяй: заказ подтвердится сам. Отменить заказ и закрыть счёт?'
              : 'Отменить заказ? Оплатить его будет уже нельзя — при желании оформишь заново.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Своя кнопка, а не ComicButton: цвет варианта задаётся тем же
                свойством `color`, и класс из пропа его не перебивает — в CSS
                побеждает не порядок в атрибуте, а порядок правил. Отменяющее
                действие должно отличаться от «Не отменять» на вид. */}
            <button
              type="button"
              disabled={sending || payInFlight}
              onClick={() => void confirm()}
              className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--color-stamp)] bg-[var(--surface)] px-4 py-2 font-display text-sm font-bold text-[var(--color-stamp)] shadow-[var(--shadow-comic)] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending ? 'Отменяю…' : 'Да, отменить'}
            </button>
            <ComicButton
              variant="surface"
              className="px-4 py-2 text-sm"
              disabled={sending}
              onClick={() => setConfirming(false)}
            >
              Не отменять
            </ComicButton>
          </div>
        </div>
      )}

      {errorText && (
        <p className="mt-2 font-body text-sm text-[var(--color-stamp)]">{errorText}</p>
      )}
    </div>
  );
}

/** Какой шаг пути показывать на листе заказа; `null` — шагов нет. */
function pathStageFor(status: string): PathStage | null {
  if (status === 'ready_for_payment' || status === 'pending_payment') return 'pay';
  if (status === 'paid' || status === 'in_fulfillment') return 'issuing';
  return null;
}

/**
 * Лист заказа: что будет после оплаты (три шага), чек, промокод, контакты,
 * баллы и кнопка «Оплатить <сумма>» (финальная сумма — на кнопке, ТЗ §3),
 * закреплённая внизу листа или нативная `MainButton` Telegram. Ниже — платежи,
 * история и блок «что дальше» после выпуска карты. Оплата проксируется наверх в
 * CabinetClient (там Telegram WebApp для открытия платёжной ссылки).
 *
 * С вкладками (трек miniapp-tabs, тикет 05) кнопка оплаты больше не серая без
 * объяснения: нажатие без почты (или телефона от порога) ведёт к полю и
 * говорит, чего не хватает (находка П8 — все семь клиентов, не дошедших до
 * счёта, не заполнили почту).
 */
export function OrderDetailView({
  order,
  hasActiveCard,
  busy,
  message,
  savedEmail,
  savedPhone,
  phoneSource,
  phoneRequiredFromRub,
  awaitingPayment = false,
  mainButton = null,
  onPay,
  onCheckPromo,
  onOpenExternalLink,
  onReportIssue,
  onReportPaymentProblem,
  onSubscriptionPaid,
  onCancel,
  onContactSupport,
  onRequestTelegramPhone,
}: Props) {
  // Плашка контактов (тикеты 02/05). markSubmitted — оптимистично при нажатии
  // «Оплатить»: сервер сохраняет контакты ДО создания счёта, поэтому даже
  // неудачная оплата их не теряет.
  const contacts = useContacts({ email: savedEmail, phone: savedPhone });
  // Переключатель списания баллов. ВЫКЛЮЧЕН по умолчанию: тратить баллы —
  // осознанное решение клиента, а не наше за него (решение Q3).
  const [useBonus, setUseBonus] = useState(false);
  // Промокод, который клиент применил на этом экране (трек promo-codes).
  // Вместе со скидкой держим ПЕРЕСЧИТАННОЕ предложение по баллам: их потолок
  // зависит от промокода, и показать старое значило бы назвать сумму, которой
  // в счёте не будет.
  const [promo, setPromo] = useState<{
    code: string;
    discountKopecks: number;
    capped: boolean;
    bonusOffer: OrderDetail['bonusOffer'];
  } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  // Чего не хватило при последнем нажатии «Оплатить» (тикет 05). Текст висит,
  // пока поле не станет валидным, — см. `emailError`/`phoneError` ниже.
  const [blocked, setBlocked] = useState<PayBlockReason | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  // При применённом промокоде баллы считаются от остатка маржи — берём
  // предложение из ответа проверки, а не из снапшота заказа.
  const bonusOffer = (promo ? promo.bonusOffer : order.bonusOffer) ?? null;
  // Счёт уже выставлен: списывать поздно (сумму инвойса не переставить), но
  // сказать об этом стоит — и только тому, у кого баллы вообще есть.
  const invoiceIssued = order.status === 'pending_payment';
  // Сколько списывается прямо сейчас. У выставленного счёта это ФАКТ (строка
  // списания привязана к живому инвойсу), у черновика — выбор клиента.
  // Кнопка обязана назвать ту же сумму, что попросит платёжная страница.
  const bonusDiscountKopecks = invoiceIssued
    ? order.bonus?.discountKopecks ?? 0
    : useBonus
      ? bonusOffer?.offer?.discountKopecks ?? 0
      : 0;
  // Скидка промокода — так же: у выставленного счёта ФАКТ из заказа, у
  // черновика выбор клиента.
  const promoDiscountKopecks = invoiceIssued
    ? order.promo?.discountKopecks ?? 0
    : promo?.discountKopecks ?? 0;
  const payableKopecks =
    order.amountKopecks !== null
      ? order.amountKopecks - bonusDiscountKopecks - promoDiscountKopecks
      : null;

  /**
   * Проверить код на сервере. Возвращает текст ошибки или `null` при успехе —
   * так поле само решает, что показать под собой.
   *
   * ⚠️ Успех сбрасывает выбор баллов: потолок пересчитан, и прежняя галка могла
   * бы относиться к предложению, которого больше нет.
   */
  const applyPromo = async (code: string): Promise<string | null> => {
    setPromoBusy(true);
    try {
      const result = await onCheckPromo(code);
      if (!result.ok) return result.message ?? 'Промокод не сработал.';
      setPromo({
        code,
        discountKopecks: result.discountKopecks,
        capped: result.capped,
        bonusOffer: result.bonusOffer ?? null,
      });
      setUseBonus(false);
      return null;
    } finally {
      setPromoBusy(false);
    }
  };
  // Сравнение суммы с порогом — общий isPhoneRequiredForAmount (одно место
  // конверсии рубли→копейки на гейт и обе плашки).
  const phoneRequired = isPhoneRequiredForAmount(order.amountKopecks, phoneRequiredFromRub);
  const blockReason = payBlockReason({
    emailOk: contacts.email.ok,
    phoneRequired,
    phoneOk: contacts.phone.ok,
  });

  const handlePay = () => {
    const toSend = {
      ...(contacts.email.toSend !== undefined ? { email: contacts.email.toSend } : {}),
      ...(contacts.phone.toSend !== undefined ? { phone: contacts.phone.toSend } : {}),
    };
    contacts.markSubmitted();
    // Флаг выводим из ФАКТА предложения, а не из одной галки: просьба скидки,
    // которой нет, получила бы от сервера честный отказ вместо счёта.
    onPay(
      toSend,
      !invoiceIssued && useBonus && bonusOffer?.offer != null,
      !invoiceIssued && promo ? promo.code : undefined,
    );
  };

  /**
   * Нажатие «Оплатить». Кнопка не отключается из-за контактов: без почты (или
   * телефона от порога) нажатие ведёт к полю, ставит в него фокус и называет,
   * чего не хватает. Счёт не запрашивается — гейт всё равно отказал бы.
   */
  const onPayTap = () => {
    if (busy !== null) return;
    if (blockReason) {
      track('pay_blocked_tap', { reason: blockReason });
      setBlocked(blockReason);
      const field = (blockReason === 'email' ? emailRef : phoneRef).current;
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      field?.focus({ preventScroll: true });
      return;
    }
    setBlocked(null);
    handlePay();
  };

  const payLabel =
    busy === 'pay'
      ? 'Готовлю счёт…'
      : payableKopecks !== null
        ? `Оплатить ${formatRub(payableKopecks)}`
        : 'Оплатить';

  useMainButton({
    button: mainButton,
    visible: order.payable,
    text: payLabel,
    busy: busy === 'pay',
    onClick: onPayTap,
  });

  const stage = pathStageFor(order.status);
  const usdCents =
    order.originalCurrency === 'USD' && order.originalAmount !== null && order.originalAmount > 0
      ? order.originalAmount
      : null;
  const paidKopecks =
    order.amountKopecks !== null
      ? order.amountKopecks - (order.bonus?.discountKopecks ?? 0) - (order.promo?.discountKopecks ?? 0)
      : null;
  const steps = stage
    ? buildPathSteps({
        stage,
        service: order.service,
        payText:
          stage === 'pay'
            ? payableKopecks !== null
              ? formatRub(payableKopecks)
              : null
            : paidKopecks !== null
              ? formatRub(paidKopecks)
              : null,
        cardText: usdCents !== null ? formatUsd(usdCents) : null,
        siteHost: siteHostFromUrl(order.instructions?.paymentUrl),
        topUp: hasActiveCard,
      })
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-body text-sm text-[var(--text-muted)]">{order.shortId}</span>
        <StatusBadge status={order.status} label={order.statusLabel} />
      </div>

      {/* Оплачен, а выдача упала: без этого плашка «Ошибка» стояла без единого
          слова, и заплативший клиент не знал, пропали ли деньги. */}
      {isPaidButIssueFailed(order) && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2.5"
        >
          <p className="font-body text-sm text-[var(--text)]">{ISSUE_FAILED_TEXT}</p>
          {onContactSupport && (
            <button
              type="button"
              onClick={onContactSupport}
              className="self-start rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-2.5 py-1 font-display text-xs text-[var(--text)]"
            >
              Написать в поддержку
            </button>
          )}
        </div>
      )}

      {awaitingPayment && order.status === 'pending_payment' && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-[12px] border-2 border-[var(--color-teal-deep)] px-3 py-2 font-body text-sm text-[var(--text)]"
        >
          <span aria-hidden className="flex gap-1">
            {['0s', '0.15s', '0.3s'].map((delay) => (
              <span
                key={delay}
                className="size-1.5 rounded-full bg-[var(--accent)] motion-safe:animate-[dot-bounce_1s_ease-in-out_infinite]"
                style={{ animationDelay: delay }}
              />
            ))}
          </span>
          Жду подтверждения оплаты…
        </p>
      )}

      {steps && <PathSteps steps={steps} boxed />}

      <div>
        <dl className="space-y-1.5">
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
              paid={order.paidAt !== null}
            />
          )}
          {order.paidAt && <Row label="Оплачен" value={formatExpires(order.paidAt)} />}
          {order.fulfilledAt && <Row label="Карта выдана" value={formatExpires(order.fulfilledAt)} />}
        </dl>

        {order.amountKopecks !== null && (
          <HowPriceComputed order={order} hasActiveCard={hasActiveCard} />
        )}
      </div>

      {order.payable && (
        <>
          {/* Промокод ВЫШЕ баллов и отдельной строкой над почтой (находка
              П7: «Есть промокод?» слипался с кнопкой «Оплатить») — в том же
              порядке, в каком считается скидка: сначала промокод, потом баллы
              от остатка маржи. */}
          {order.promoInputEnabled && !invoiceIssued && (
            <PromoCodeBlock
              applied={promo}
              onApply={applyPromo}
              onClear={() => {
                setPromo(null);
                setUseBonus(false);
              }}
              busy={promoBusy}
              disabled={busy !== null}
            />
          )}
          <ContactCard
            contacts={contacts}
            phoneRequired={phoneRequired}
            phoneRequiredFromRub={phoneRequiredFromRub}
            phoneSource={phoneSource}
            onRequestTelegramPhone={onRequestTelegramPhone}
            emailLabel="Почта — нужна для оплаты"
            emailHint="Напишем, только если банк задержит платёж."
            emailInputRef={emailRef}
            phoneInputRef={phoneRef}
            emailError={blocked === 'email' && !contacts.email.ok ? PAY_BLOCK_TEXT.email : null}
            phoneError={blocked === 'phone' && !contacts.phone.ok ? PAY_BLOCK_TEXT.phone : null}
          />
          {bonusOffer && order.amountKopecks !== null && !invoiceIssued && (
            <BonusSpendBlock
              bonus={bonusOffer}
              enabled={useBonus}
              onToggle={setUseBonus}
              totalKopecks={order.amountKopecks - promoDiscountKopecks}
              disabled={busy !== null}
            />
          )}
          {/* Счёт уже выставлен: переставить его сумму мы не умеем (API
              правки инвойса нет ни у Freekassa, ни у L&P), а второй счёт на
              заказ запрещён частичным UNIQUE. Говорим прямо, что делать. */}
          {invoiceIssued && bonusOffer?.offer && !order.bonus && (
            <p className="rounded-[10px] border-2 border-dashed border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
              Счёт уже выставлен. Чтобы списать баллы, отмени заказ и оформи заново.
            </p>
          )}
          {invoiceIssued && order.bonus && order.amountKopecks !== null && (
            <p className="rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text)]">
              Баллами списано {formatRub(order.bonus.discountKopecks)} — счёт выставлен на{' '}
              {formatRub(order.amountKopecks - order.bonus.discountKopecks)}.
            </p>
          )}
          {/* Промокод по выставленному счёту — ФАКТ. Сумму называем ту, что
              уже ушла шлюзу: обе скидки вычтены (трек promo-codes). */}
          {invoiceIssued && order.promo && order.amountKopecks !== null && (
            <p className="rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text)]">
              Промокод применён: −{formatRub(order.promo.discountKopecks)}. Счёт выставлен на{' '}
              {formatRub(
                order.amountKopecks -
                  order.promo.discountKopecks -
                  (order.bonus?.discountKopecks ?? 0),
              )}
              .
            </p>
          )}
          {/* ⚠️ Надбавка платёжной системы считается от суммы СЧЁТА, а не
              от цены заказа: провайдер начисляет её на то, что мы у него
              запросили. С применённой скидкой полная цена обещала бы клиенту
              неверное число на странице оплаты — ровно то, что исправлено в
              напоминании об оплате из панели. */}
          {payableKopecks !== null &&
            buyerFeeAmountNote(payableKopecks, order.buyerFeePercent, formatRub) !== null && (
              <p className="rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text)]">
                {buyerFeeAmountNote(payableKopecks, order.buyerFeePercent, formatRub)}
              </p>
            )}
        </>
      )}

      {message && (
        <div
          className={[
            'flex flex-wrap items-center justify-between gap-2 rounded-[12px] border-2 px-3 py-2',
            message.tone === 'ok'
              ? 'border-[var(--color-teal-deep)]'
              : 'border-[var(--color-stamp)]',
          ].join(' ')}
        >
          <p
            role={message.tone === 'err' ? 'alert' : 'status'}
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

      {/* «Проблема с оплатой» — фаза до выпуска (тикет 10 антифрод-трека). */}
      {showPaymentProblemButton(order) && (
        <PaymentProblemBlock onReport={onReportPaymentProblem} />
      )}

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
          <h3 className="font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
            Платежи
          </h3>
          {order.payments.map((p) => (
            <div
              key={`${p.invoiceNumber ?? 'inv'}-${p.createdAt}`}
              className="flex items-center justify-between gap-3 rounded-[14px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5"
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
          <h3 className="font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
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

      {/* Закреплённый низ листа (тикет 05): кнопка оплаты во всю ширину — или
          нативная MainButton Telegram, тогда своей кнопки нет, — срок цены и
          отмена. Липкий внутри прокрутки листа, поэтому виден всегда. */}
      {order.payable && (
        <div className="sticky bottom-0 -mx-4 mt-1 flex flex-col gap-1.5 border-t-2 border-[color-mix(in_srgb,var(--text-muted)_22%,transparent)] bg-[var(--surface)] px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
          {!mainButton && (
            <button
              type="button"
              onClick={onPayTap}
              disabled={busy !== null}
              className="flex min-h-[50px] w-full items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-3 font-display text-[17px] font-bold text-[var(--color-paper)] shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {payLabel}
            </button>
          )}
          {order.expiresAt && (
            <p className="text-center font-body text-[13px] text-[var(--text-muted)]">
              Цена зафиксирована до {formatExpires(order.expiresAt)}
              {order.buyerFeePercent > 0
                ? ' — наша сумма не изменится.'
                : ' — после оплаты сумма не изменится.'}
            </p>
          )}
          <CancelOrderBlock
            invoiceIssued={order.status === 'pending_payment'}
            payInFlight={busy === 'pay'}
            onCancel={onCancel}
          />
          {/* Условия и политика — здесь, у оплаты, а не кнопками в «Профиле»:
              в Mini App документы ищут там, где принимают деньги, как в любом
              платёжном экране. Политику Telegram ещё и сам показывает в меню
              Mini App — по ссылке из @BotFather. */}
          <p className="text-center font-body text-xs text-[var(--text-muted)]">
            Оплачивая, ты принимаешь{' '}
            <button
              type="button"
              onClick={() => onOpenExternalLink(`${SITE_ORIGIN}/terms`)}
              className="underline underline-offset-2"
            >
              условия сервиса
            </button>{' '}
            и{' '}
            <button
              type="button"
              onClick={() => onOpenExternalLink(`${SITE_ORIGIN}/privacy`)}
              className="underline underline-offset-2"
            >
              политику конфиденциальности
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
