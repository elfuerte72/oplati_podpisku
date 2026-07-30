import type { ReactNode } from 'react';
import { buyerFeeAmountNote } from '@/lib/payments/buyer-fee';
import { formatRub, formatUsd } from './format';
import { BreakdownDetails } from './BreakdownDetails';

type OrderRow = { label: string; value: string };

type OrderPanelProps = {
  title?: string;
  service: string;
  rows?: OrderRow[];
  amountKopecks: number;
  /** Оригинальная цена подписки в USD-центах; показываем «$ на сайте + ₽ у нас». */
  amountUsdCents?: number | null;
  /**
   * Надбавка платёжной системы на плательщика, % (0 — её нет). При ненулевой
   * рядом с суммой показываем, сколько клиент реально увидит на странице шлюза:
   * узнать об этом на самой странице оплаты — худший момент.
   */
  buyerFeePercent?: number;
  confirm?: ReactNode;
  secondary?: ReactNode;
  stamp?: ReactNode;
  /**
   * Где показана панель («web_chat»). Задан — раскрытие «Как рассчитана сумма»
   * попадает в аналитику. Строка, а не колбэк: функция-проп не переживает
   * границу серверного и клиентского компонента.
   */
  analyticsSurface?: string;
};

/** Панель заказа (propose_order) — комикс-панель с суммой и подтверждением. */
export function OrderPanel({
  title = 'Заказ',
  service,
  rows = [],
  amountKopecks,
  amountUsdCents,
  buyerFeePercent = 0,
  confirm,
  secondary,
  stamp,
  analyticsSurface,
}: OrderPanelProps) {
  return (
    <div
      className={[
        'relative w-[320px] max-w-full bg-[var(--surface)] p-5',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic-lg)]',
      ].join(' ')}
    >
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h3>
      <p className="mt-1 font-display text-xl font-bold text-[var(--text)]">
        {service}
      </p>

      {rows.length > 0 && (
        <dl className="mt-3 space-y-1 font-body text-sm text-[var(--text-muted)]">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <dt>{row.label}</dt>
              <dd className="text-[var(--text)]">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="my-4 border-t-2 border-[var(--shadow-ink)]" />

      {amountUsdCents != null && amountUsdCents > 0 && (
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-body text-sm text-[var(--text-muted)]">Цена подписки</span>
          <span className="font-display text-lg font-bold text-[var(--text)]">
            {formatUsd(amountUsdCents)}
          </span>
        </div>
      )}

      <div className="flex items-baseline justify-between">
        <span className="font-body text-sm text-[var(--text-muted)]">К оплате</span>
        <span className="font-display text-2xl font-bold text-[var(--accent)]">
          {formatRub(amountKopecks)}
        </span>
      </div>

      {amountUsdCents != null && amountUsdCents > 0 && (
        <p className="mt-1 font-body text-xs text-[var(--text-muted)]">
          $ — цена на сайте сервиса (в США), ₽ — сколько спишем у нас
        </p>
      )}

      {buyerFeeAmountNote(amountKopecks, buyerFeePercent, formatRub) !== null && (
        <p className="mt-2 rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-xs leading-snug text-[var(--text)]">
          {buyerFeeAmountNote(amountKopecks, buyerFeePercent, formatRub)}
        </p>
      )}

      {/* «Как рассчитана сумма» (ТЗ §3) — раскрывающийся блок без сюрпризов. */}
      <BreakdownDetails
        className="group mt-2 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2"
        summaryClassName="cursor-pointer list-none font-display text-xs font-bold text-[var(--text)]"
        analyticsSurface={analyticsSurface}
        summary={
          <>
            <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
            Как рассчитана сумма
          </>
        }
      >
        <p className="mt-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
          Итог = цена подписки в долларах × курс на момент заказа + комиссия сервиса
          (рассчитывается системой). Если это твой первый заказ и виртуальной карты ещё
          нет, разово добавляется её выпуск — $4 (столько стоит выпуск карты, дальше
          заказы идут на неё же без этой надбавки).{' '}
          {buyerFeePercent > 0
            ? 'Наша сумма после создания заказа не меняется, комиссия платёжной системы добавляется при оплате — она указана выше.'
            : 'После создания заказа сумма не меняется: платишь ровно столько, сколько на кнопке.'}
        </p>
      </BreakdownDetails>

      {(confirm || secondary) && (
        <div className="mt-4 flex items-center gap-3">
          {confirm}
          {secondary}
        </div>
      )}

      {stamp && (
        <div className="pointer-events-none absolute right-4 top-4">{stamp}</div>
      )}
    </div>
  );
}
