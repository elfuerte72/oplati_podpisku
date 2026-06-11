import { formatExpires } from './format';

type PaymentBlockProps = {
  paymentUrl: string;
  qrPayload: string | null;
  expiresAt: string;
};

/** Блок оплаты (confirm_order) — кнопка-ссылка на счёт + QR-подсказка + срок. */
export function PaymentBlock({ paymentUrl, qrPayload, expiresAt }: PaymentBlockProps) {
  return (
    <div className="w-[320px] max-w-full rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic-lg)]">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">
        Счёт готов
      </h3>
      <a
        href={paymentUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={[
          'mt-3 inline-block text-center font-display font-bold text-[var(--color-paper)]',
          'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)]',
          'shadow-[var(--shadow-comic)] px-5 py-3 transition-[transform,box-shadow]',
          'active:translate-x-[3px] active:translate-y-[3px] active:shadow-none',
        ].join(' ')}
      >
        Оплатить
      </a>
      {qrPayload && (
        <p className="mt-3 font-body text-sm text-[var(--text)]">
          Или отсканируй QR-код в приложении банка по СБП.
        </p>
      )}
      <p className="mt-2 font-body text-xs text-[var(--text-muted)]">
        Счёт действует до {formatExpires(expiresAt)}.
      </p>
    </div>
  );
}
