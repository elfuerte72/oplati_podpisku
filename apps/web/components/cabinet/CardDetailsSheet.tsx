'use client';

import { useEffect, useState } from 'react';

import type { BillingAddress } from '@oplati/types';

import { track } from '@/lib/analytics/client';
import { billingAddressFields } from '@/lib/billing-address-fields';
import { copyCardField, type CardCopyField } from '@/lib/cabinet/copy-field';
import { copyToClipboard } from '@/lib/clipboard';

import { fetchCardDetails } from './cabinet-api';
import { errorTextFor } from './error-text';

/**
 * Лист «Реквизиты карты» (трек miniapp-tabs, тикет 07), вид —
 * `mockup/CardDetails.dc.html`.
 *
 * Что изменилось против прежнего показа на главном экране:
 *  - значения — выделяемый текст, а не кнопки, и рядом явная «Копировать»:
 *    прежний тап по значению звал голый `navigator.clipboard` и глотал отказ
 *    (находка П11) — в Telegram WebView буфер часто закрыт, и клиент вставлял
 *    на сайт сервиса то, что лежало в буфере до этого;
 *  - адрес плательщика — здесь же (находка П12): до этого он был только в
 *    сообщении бота, а сайты сервисов его спрашивают;
 *  - реквизиты живут, пока открыт лист: закрыли — состояние размонтировано и
 *    значения сброшены (таймер «через минуту» больше не нужен).
 *
 * ⚠️ PAN/CVC/адрес не уходят ни в `track()`, ни в логи: `card_details_view` —
 * без свойств, `card_copy` — только имя поля и исход.
 */

type Details = { number: string; exp: string; cvc: string; billingAddress: BillingAddress | null };

const COPY_FAILED_TEXT = 'Не удалось скопировать — выдели значение и скопируй вручную.';

function IconCopy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

export function CardDetailsSheet({ initData, cardId }: { initData: string; cardId: string }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchCardDetails(initData, cardId);
      if (cancelled) return;
      if (res.ok) {
        // Только факт показа. Ни PAN, ни CVC, ни адрес в телеметрию не
        // попадают никогда — маска номера тоже не нужна.
        track('card_details_view');
        setDetails({
          number: res.number,
          exp: res.exp,
          cvc: res.cvc,
          billingAddress: res.billingAddress ?? null,
        });
      } else {
        setError(
          res.error === 'network_error'
            ? 'Не удалось показать реквизиты. Попробуй ещё раз.'
            : errorTextFor(res.error),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initData, cardId]);

  if (error) {
    return (
      <p role="alert" className="rounded-[12px] border-2 border-[var(--color-stamp)] px-3 py-2 font-body text-sm text-[var(--color-stamp)]">
        {error}
      </p>
    );
  }
  if (!details) {
    return (
      <p role="status" className="py-6 text-center font-body text-sm text-[var(--text-muted)]">
        Загружаю реквизиты…
      </p>
    );
  }

  return <CardDetailsView details={details} />;
}

/** Отрисовка реквизитов — отдельно от загрузки, чтобы стенд показывал её без сети. */
export function CardDetailsView({ details }: { details: Details }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col">
        <DetailRow label="Номер" value={details.number} copyValue={details.number.replace(/\s/g, '')} field="number" mono />
        <DetailRow label="Срок" value={details.exp} field="exp" mono />
        <DetailRow label="CVC" value={details.cvc} field="cvc" mono />
      </div>
      <p className="font-body text-[13px] text-[var(--text-muted)]">
        Имя на карте, если спросят, — любое латиницей.
      </p>

      {details.billingAddress && (
        <>
          <div className="mt-1.5">
            <h3 className="font-body text-base font-semibold text-[var(--text)]">
              Адрес плательщика (Billing address)
            </h3>
            <p className="mt-0.5 font-body text-[13px] leading-snug text-[var(--text-muted)]">
              Если сайт спросит — вводи этот, так и задумано: адрес закреплён за твоей картой.
            </p>
          </div>
          <div className="flex flex-col">
            {billingAddressFields(details.billingAddress).map((f) => (
              <DetailRow
                key={f.label}
                label={f.label}
                value={f.value}
                field="address"
                mono={f.label === 'ZIP'}
              />
            ))}
          </div>
        </>
      )}

      <p className="mt-1 text-center font-body text-[13px] text-[var(--text-muted)]">
        Реквизиты скроются, когда закроешь этот экран.
      </p>
    </div>
  );
}

function DetailRow({
  label,
  value,
  copyValue,
  field,
  mono = false,
}: {
  label: string;
  value: string;
  /** Что класть в буфер, если отличается от видимого (номер — без пробелов). */
  copyValue?: string;
  field: CardCopyField;
  mono?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    const result = await copyCardField(
      { field, value: copyValue ?? value },
      { copy: copyToClipboard, track },
    );
    setState(result);
    if (result === 'copied') window.setTimeout(() => setState('idle'), 1600);
  };

  return (
    <div className="border-b border-[color-mix(in_srgb,var(--text-muted)_20%,transparent)] py-1.5">
      <div className="flex min-h-[52px] items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block font-body text-xs text-[var(--text-muted)]">{label}</span>
          <span
            // Значение — выделяемый текст: если буфер откажет, его можно
            // выделить пальцем и скопировать вручную.
            data-swipe-ignore
            className={[
              'block cursor-text text-base font-medium break-all text-[var(--text)] select-all',
              mono ? 'font-mono' : 'font-body',
            ].join(' ')}
          >
            {value}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Скопировать: ${label}`}
          className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-2.5 py-1.5 font-body text-[13px] font-semibold text-[var(--text)] active:translate-x-px active:translate-y-px"
        >
          <IconCopy />
          {state === 'copied' ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      {state === 'failed' && (
        <p role="alert" className="pb-1 font-body text-xs text-[var(--color-stamp)]">
          {COPY_FAILED_TEXT}
        </p>
      )}
    </div>
  );
}
