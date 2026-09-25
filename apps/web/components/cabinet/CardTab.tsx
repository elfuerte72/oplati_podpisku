'use client';

import { useState } from 'react';

import { formatDayMonth, formatRub, formatUsd } from '@/components/comic/format';
import { IconArrowRight } from '@/components/comic/icons';
import { track } from '@/lib/analytics/client';
import type { CardTabState } from '@/lib/cabinet/card-tab-state';
import { ISSUE_FAILED_TEXT } from '@/lib/cabinet/issue-failed';
import { buildPathSteps, siteHostFromUrl, serviceStepHint } from '@/lib/cabinet/path-steps';

import type { CardView, OrderSummary, SubscriptionPaidResult } from './cabinet-api';
import { CardFacts, CardVisual } from './CardHero';
import { PathSteps } from './PathSteps';
import { ServiceInitial } from './ServiceInitial';

/**
 * Вкладка «Карта» (трек miniapp-tabs, тикет 06), вид — `mockup/Card.dc.html`,
 * `CardEmpty.dc.html`, `Issuing.dc.html`.
 *
 * Главное после оплаты — шаг 3, «оплати сервис этой картой». До вкладок его
 * экран открывался только через «Не проходит оплата?», и «Подписка оформлена»
 * не нажимал никто. Здесь он — первая карточка под картой, пока клиент не
 * отметит подписку (правило — `selectCardTabState`).
 */

const sectionTitle =
  'font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]';
const cardBox =
  'flex flex-col gap-3 rounded-[18px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]';
const primaryButton =
  'flex min-h-[50px] w-full items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-3 font-display text-[17px] font-bold text-[var(--color-paper)] shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:opacity-60';
const secondaryButton =
  'flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5 font-display text-[15px] font-bold text-[var(--text)] shadow-[3px_3px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-60';
const quietLink =
  'flex min-h-11 items-center self-center font-body text-sm text-[var(--text-muted)] underline underline-offset-[3px]';

function IconExternal() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
    </svg>
  );
}

function IconCardSmall() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

function IconTick() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.2 4L19 7" />
    </svg>
  );
}

/** Сумма, которую клиент заплатил: полная цена минус скидки (баллы, промокод). */
function paidKopecks(order: OrderSummary): number | null {
  if (order.amountKopecks === null) return null;
  return order.amountKopecks - (order.bonus?.discountKopecks ?? 0) - (order.promo?.discountKopecks ?? 0);
}

export function CardTab({
  state,
  issuing,
  onGoPay,
  onOpenCardDetails,
  onOpenOrder,
  onOpenIssue,
  onMarkSubscriptionPaid,
  onOpenExternalLink,
  onContactSupport,
}: {
  state: CardTabState<OrderSummary, CardView>;
  /** Сколько ляжет на карту и сайт сервиса (из детали заказа); null — не знаем. */
  issuing: { usdCents: number | null; siteHost: string | null } | null;
  onGoPay: () => void;
  onOpenCardDetails: (cardId: string) => void;
  onOpenOrder: (orderId: string) => void;
  /** Лист «Не получается оплатить?» по заказу. */
  onOpenIssue: (orderId: string) => void;
  onMarkSubscriptionPaid: (orderId: string) => Promise<SubscriptionPaidResult>;
  onOpenExternalLink: (url: string) => void;
  /** Выход в поддержку; `undefined` — приложение не умеет закрыться в чат. */
  onContactSupport?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-[18px]">
      <header className="pt-1">
        <h1 className="font-display text-[26px] leading-tight font-bold text-[var(--text)]">Карта</h1>
      </header>

      {state.kind === 'none' && <NoCard onGoPay={onGoPay} />}

      {state.kind === 'issuing' && (
        <Issuing
          order={state.order}
          topUp={state.topUp}
          usdCents={issuing?.usdCents ?? null}
          siteHost={issuing?.siteHost ?? null}
        />
      )}

      {state.kind === 'issue_failed' && (
        <IssueFailed
          order={state.order}
          onOpenOrder={onOpenOrder}
          onContactSupport={onContactSupport}
        />
      )}

      {state.kind === 'active' && (
        <ActiveCard
          card={state.card}
          nextStep={state.nextStep}
          cardOrders={state.cardOrders}
          onGoPay={onGoPay}
          onOpenCardDetails={onOpenCardDetails}
          onOpenOrder={onOpenOrder}
          onOpenIssue={onOpenIssue}
          onMarkSubscriptionPaid={onMarkSubscriptionPaid}
          onOpenExternalLink={onOpenExternalLink}
        />
      )}
    </div>
  );
}

function NoCard({ onGoPay }: { onGoPay: () => void }) {
  return (
    <>
      <div className="flex aspect-[1.6/1] flex-col items-center justify-center gap-1.5 rounded-[20px] border-[2.5px] border-dashed border-[color-mix(in_srgb,var(--text-muted)_45%,transparent)] p-5 text-center">
        <p className="font-display text-xl font-bold text-[var(--text)]">Карты пока нет</p>
        <p className="font-body text-sm text-[var(--text-muted)]">
          Появится после первой оплаты заказа — здесь и в чате с ботом.
        </p>
      </div>
      <div className={cardBox}>
        <h2 className="font-display text-xl font-bold text-[var(--text)]">Как это работает</h2>
        <PathSteps steps={buildPathSteps({ stage: 'explain' })} />
        <button type="button" onClick={onGoPay} className={primaryButton}>
          Выбрать сервис
        </button>
      </div>
    </>
  );
}

function Issuing({
  order,
  topUp,
  usdCents,
  siteHost,
}: {
  order: OrderSummary;
  topUp: boolean;
  usdCents: number | null;
  siteHost: string | null;
}) {
  const paid = paidKopecks(order);
  return (
    <>
      <div
        role="status"
        className="flex aspect-[1.6/1] flex-col items-center justify-center gap-2.5 rounded-[20px] border-[2.5px] border-dashed border-[color-mix(in_srgb,var(--text-muted)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-teal-primary)_8%,transparent)] p-5 text-center"
      >
        <span aria-hidden className="flex gap-2">
          {['var(--color-teal-light)', 'var(--color-teal-primary)', 'var(--color-teal-deep)'].map((color, i) => (
            <span
              key={color}
              className="size-2.5 rounded-full motion-safe:animate-[dot-bounce_1s_ease-in-out_infinite]"
              style={{ background: color, animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        <p className="font-display text-xl font-bold text-[var(--text)]">
          {/* При уже выпущенной карте долить её или выпустить новую решает
              сервер — заголовок не обещает ни того, ни другого. */}
          {topUp ? `Готовлю карту для ${order.service}` : `Выпускаю карту для ${order.service}`}
        </p>
        <p className="font-body text-sm text-[var(--text-muted)]">
          Обычно это пара минут. Покажу её здесь и пришлю в чат.
        </p>
      </div>
      <div className={cardBox}>
        <p className={sectionTitle}>Оплата прошла</p>
        <PathSteps
          steps={buildPathSteps({
            stage: 'issuing',
            service: order.service,
            payText: paid !== null ? formatRub(paid) : null,
            cardText: usdCents !== null ? formatUsd(usdCents) : null,
            siteHost,
            topUp,
          })}
        />
      </div>
    </>
  );
}

/**
 * Оплачен, а выдача упала. Без этого экрана «Выпускаю карту…» сменялось
 * «Карты пока нет»: только что заплативший видел пустоту. Слова — те же, что в
 * сообщении бота (`ISSUE_FAILED_TEXT`), и не обещают ни срока, ни того, что
 * карты нет: при части сбоев она выпущена, но не записалась у нас.
 */
function IssueFailed({
  order,
  onOpenOrder,
  onContactSupport,
}: {
  order: OrderSummary;
  onOpenOrder: (orderId: string) => void;
  onContactSupport?: (() => void) | undefined;
}) {
  return (
    <>
      <div
        role="status"
        className="flex aspect-[1.6/1] flex-col items-center justify-center gap-1.5 rounded-[20px] border-[2.5px] border-dashed border-[color-mix(in_srgb,var(--text-muted)_45%,transparent)] p-5 text-center"
      >
        <p className="font-display text-xl font-bold text-[var(--text)]">
          Карта для {order.service} задерживается
        </p>
        <p className="font-body text-sm text-[var(--text-muted)]">Заказ {order.shortId}</p>
      </div>
      <div className={cardBox}>
        <p className={sectionTitle}>Оплата прошла</p>
        <p className="font-body text-sm text-[var(--text)]">{ISSUE_FAILED_TEXT}</p>
        {onContactSupport && (
          <button type="button" onClick={onContactSupport} className={secondaryButton}>
            Написать в поддержку
          </button>
        )}
        <button type="button" onClick={() => onOpenOrder(order.orderId)} className={quietLink}>
          Открыть заказ
        </button>
      </div>
    </>
  );
}

function ActiveCard({
  card,
  nextStep,
  cardOrders,
  onGoPay,
  onOpenCardDetails,
  onOpenOrder,
  onOpenIssue,
  onMarkSubscriptionPaid,
  onOpenExternalLink,
}: {
  card: CardView;
  nextStep: OrderSummary | null;
  cardOrders: readonly OrderSummary[];
  onGoPay: () => void;
  onOpenCardDetails: (cardId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onOpenIssue: (orderId: string) => void;
  onMarkSubscriptionPaid: (orderId: string) => Promise<SubscriptionPaidResult>;
  onOpenExternalLink: (url: string) => void;
}) {
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Правила сервиса у карты — от САМОГО СВЕЖЕГО её заказа в любом статусе, а
  // шаг 3 — от последнего выполненного. Совпали — берём; разошлись (свежий
  // заказ сорвался) — ни сайта, ни подсказки: «Оплати A» с кнопкой сайта B
  // сбил бы сильнее, чем их отсутствие (находка ревью).
  const instructions =
    nextStep && card.purposeOrderId === nextStep.orderId ? card.instructions : null;
  const paymentUrl = instructions?.paymentUrl ?? null;
  const siteHost = siteHostFromUrl(paymentUrl);
  const latest = cardOrders[0] ?? null;

  const markPaid = async (orderId: string) => {
    if (marking) return;
    setMarking(true);
    setError(null);
    const res = await onMarkSubscriptionPaid(orderId);
    setMarking(false);
    // Успех карточку уберёт перечитанный снапшот (подписка отмечена) — здесь
    // показывать нечего; отказ говорим прямо у кнопки.
    if (!res.ok) setError(res.message);
  };

  const detailsButton = (
    <button type="button" onClick={() => onOpenCardDetails(card.id)} className={secondaryButton}>
      <IconCardSmall />
      Показать реквизиты и адрес
    </button>
  );

  return (
    <>
      <CardVisual card={card} />

      {nextStep ? (
        <section
          aria-label="Остался один шаг"
          className="flex flex-col gap-3 rounded-[18px] border-[2.5px] border-[var(--color-teal-primary)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]"
        >
          <div>
            <p className={sectionTitle}>Остался один шаг</p>
            <h2 className="mt-1 font-display text-[22px] leading-tight font-bold text-[var(--text)]">
              Оплати {nextStep.service} этой картой
            </h2>
          </div>
          <PathSteps
            steps={buildPathSteps({
              stage: 'use',
              service: nextStep.service,
              cardText: formatUsd(card.balanceUsdCents),
              siteHost,
              useHint: serviceStepHint(instructions),
            })}
          />
          {paymentUrl && (
            <button
              type="button"
              onClick={() => {
                // Последнее наблюдаемое действие перед сайтом сервиса: дальше
                // клиент вне периметра до отметки об успехе или жалобы.
                track('service_site_click', { target: 'payment_url' }, { immediate: true });
                onOpenExternalLink(paymentUrl);
              }}
              className={primaryButton}
            >
              Открыть {siteHost ?? 'сайт сервиса'}
              <IconExternal />
            </button>
          )}
          {detailsButton}
          <button
            type="button"
            disabled={marking}
            onClick={() => void markPaid(nextStep.orderId)}
            className={secondaryButton}
          >
            <IconTick />
            {marking ? 'Отмечаю…' : 'Подписка оформлена'}
          </button>
          {error && (
            <p role="alert" className="font-body text-sm text-[var(--color-stamp)]">
              {error}
            </p>
          )}
          <button type="button" onClick={() => onOpenIssue(nextStep.orderId)} className={quietLink}>
            Не получается оплатить?
          </button>
        </section>
      ) : (
        <div className="flex flex-col gap-1">
          {detailsButton}
          {latest && (
            <button type="button" onClick={() => onOpenIssue(latest.orderId)} className={quietLink}>
              Не получается оплатить?
            </button>
          )}
        </div>
      )}

      <CardFacts card={card} />

      <section className="flex flex-col gap-2">
        {cardOrders.length > 0 && (
          <>
            <h2 className={sectionTitle}>Заказы по этой карте</h2>
            {cardOrders.map((order) => {
              const paid = paidKopecks(order);
              return (
                <button
                  key={order.orderId}
                  type="button"
                  onClick={() => onOpenOrder(order.orderId)}
                  className="flex w-full items-center gap-3 rounded-2xl border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-3.5 py-3 text-left transition-transform active:translate-x-[2px] active:translate-y-[2px]"
                >
                  <ServiceInitial name={order.service} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-body text-[15px] font-semibold text-[var(--text)]">
                      {order.service}
                    </span>
                    <span className="block font-body text-[13px] text-[var(--text-muted)]">
                      {paid !== null ? `${formatRub(paid)} · ` : ''}
                      {formatDayMonth(order.createdAt)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full border-2 border-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] px-2.5 py-0.5 font-body text-xs font-bold text-[var(--text)]">
                    {order.statusLabel}
                  </span>
                </button>
              );
            })}
          </>
        )}
        <button
          type="button"
          onClick={onGoPay}
          className="inline-flex min-h-10 items-center gap-1 self-start font-body text-sm text-[var(--accent)]"
        >
          Оплатить ещё сервис этой картой
          <IconArrowRight size={14} />
        </button>
      </section>
    </>
  );
}
