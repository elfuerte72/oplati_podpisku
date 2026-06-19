import { ComicButton } from '@/components/comic/ComicButton';
import { formatExpires, formatRub } from '@/components/comic/format';

import { StatusBadge } from './StatusBadge';
import type { OrderDetail } from './cabinet-api';

export type DetailActionMessage = { tone: 'ok' | 'err'; text: string };

type Props = {
  order: OrderDetail;
  busy: 'pay' | 'repeat' | 'operator' | null;
  message: DetailActionMessage | null;
  onBack: () => void;
  onPay: () => void;
  onRepeat: () => void;
  onOperator: () => void;
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
 * Экран деталей заказа: сводка, действия (оплатить / повторить / оператор),
 * таймлайн событий, платежи и карта. Действия проксируются наверх в
 * CabinetClient (там Telegram WebApp для открытия платёжной ссылки).
 */
export function OrderDetailView({
  order,
  busy,
  message,
  onBack,
  onPay,
  onRepeat,
  onOperator,
}: Props) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="font-display text-sm font-bold text-[var(--link)]"
      >
        ‹ Назад к заказам
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
            <Row label="Сумма" value={formatRub(order.amountKopecks)} />
          )}
          {order.commissionPercent !== null && (
            <Row label="Комиссия" value={`${order.commissionPercent}%`} />
          )}
          {order.paidAt && <Row label="Оплачен" value={formatExpires(order.paidAt)} />}
          {order.fulfilledAt && <Row label="Выполнен" value={formatExpires(order.fulfilledAt)} />}
          {order.expiresAt && order.payable && (
            <Row label="Счёт действует до" value={formatExpires(order.expiresAt)} />
          )}
        </dl>

        {(order.payable || order.repeatable) && (
          <div className="mt-5 flex flex-wrap gap-3">
            {order.payable && (
              <ComicButton variant="primary" onClick={onPay} disabled={busy !== null}>
                {busy === 'pay' ? 'Готовлю счёт…' : 'Оплатить'}
              </ComicButton>
            )}
            {order.repeatable && (
              <ComicButton variant="surface" onClick={onRepeat} disabled={busy !== null}>
                {busy === 'repeat' ? 'Создаю…' : 'Повторить заказ'}
              </ComicButton>
            )}
          </div>
        )}

        <div className="mt-3">
          <button
            type="button"
            onClick={onOperator}
            disabled={busy !== null}
            className="font-body text-sm text-[var(--link)] underline disabled:opacity-60"
          >
            {busy === 'operator' ? 'Отправляю заявку…' : 'Нужен оператор'}
          </button>
        </div>

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
