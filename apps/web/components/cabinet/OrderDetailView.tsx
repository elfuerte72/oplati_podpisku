import { ComicButton } from '@/components/comic/ComicButton';
import { formatExpires, formatRub, formatUsd } from '@/components/comic/format';
import { IconArrowLeft, IconCheck } from '@/components/comic/icons';

import { StatusBadge } from './StatusBadge';
import type { OrderDetail } from './cabinet-api';

export type DetailActionMessage = { tone: 'ok' | 'err'; text: string };

type Props = {
  order: OrderDetail;
  busy: 'pay' | null;
  message: DetailActionMessage | null;
  onBack: () => void;
  onPay: () => void;
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
 *  - `= 0` — повторная: «Сумма» + заметка «карта уже есть»;
 *  - `null` — заказ до фичи: просто «Сумма» (как раньше).
 */
function RubBreakdown({
  totalKopecks,
  cardIssueFeeKopecks,
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
}) {
  if (cardIssueFeeKopecks !== null && cardIssueFeeKopecks > 0) {
    return (
      <>
        <Row label="Подписка" value={formatRub(totalKopecks - cardIssueFeeKopecks)} />
        <Row label="Выпуск карты" value={`+ ${formatRub(cardIssueFeeKopecks)}`} />
        <p className="font-body text-xs text-[var(--text-muted)]">
          разово — за выпуск личной карты США; в следующих заказах этой строки не будет
        </p>
        <div className="my-1.5 border-t-2 border-dashed border-[var(--shadow-ink)]" />
        <div className="flex justify-between gap-4 font-display text-base font-bold">
          <dt className="text-[var(--text)]">Итого</dt>
          <dd className="text-[var(--text)]">{formatRub(totalKopecks)}</dd>
        </div>
      </>
    );
  }
  if (cardIssueFeeKopecks === 0) {
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
}: {
  totalKopecks: number;
  cardIssueFeeKopecks: number | null;
  originalAmountUsdCents: number | null;
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
      <RubBreakdown totalKopecks={totalKopecks} cardIssueFeeKopecks={cardIssueFeeKopecks} />
    </>
  );
}

/**
 * Экран деталей заказа: сводка, кнопка «Оплатить», таймлайн событий, платежи и
 * карта. Оплата проксируется наверх в CabinetClient (там Telegram WebApp для
 * открытия платёжной ссылки).
 */
export function OrderDetailView({ order, busy, message, onBack, onPay }: Props) {
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
              // USD-строку показываем только для долларовых заказов: formatUsd
              // жёстко форматирует в $, для не-USD валюты это был бы неверный
              // ярлык. Сейчас каталог всегда USD — проверка защитная.
              originalAmountUsdCents={order.originalCurrency === 'USD' ? order.originalAmount : null}
            />
          )}
          {order.paidAt && <Row label="Оплачен" value={formatExpires(order.paidAt)} />}
          {order.fulfilledAt && <Row label="Выполнен" value={formatExpires(order.fulfilledAt)} />}
          {order.expiresAt && order.payable && (
            <Row label="Счёт действует до" value={formatExpires(order.expiresAt)} />
          )}
        </dl>

        {order.payable && (
          <div className="mt-5">
            <ComicButton variant="primary" onClick={onPay} disabled={busy !== null}>
              {busy === 'pay' ? 'Готовлю счёт…' : 'Оплатить'}
            </ComicButton>
          </div>
        )}

        {message && (
          <p
            className={[
              'mt-4 rounded-[12px] border-2 px-3 py-2 font-body text-sm',
              message.tone === 'ok'
                ? 'border-[var(--color-teal-deep)] text-[var(--text)]'
                : 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
            ].join(' ')}
          >
            {message.text}
          </p>
        )}
      </div>

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
