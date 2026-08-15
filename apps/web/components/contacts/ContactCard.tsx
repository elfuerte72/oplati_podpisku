'use client';

import { useState } from 'react';

import { EMAIL_INVALID_TEXT, normalizeEmail } from '@/lib/contacts/email';
import { PHONE_INVALID_TEXT, normalizePhone, phoneFieldHint } from '@/lib/contacts/phone';

/**
 * Плашка контактов на экране заказа (антифрод-трек, тикеты 02/05) — ОДИН
 * компонент на сайт и Mini App (спека §3.2/§4.2). Почта обязательна всегда;
 * поле телефона появляется только при сумме от порога (порог приходит с
 * сервера — в тексты не зашивается, инвариант 10).
 *
 * Поведение поля: значения нет в профиле → ввод с подписью-объяснением; есть →
 * строка со значением и «изменить». Сохранение — вместе с нажатием «Оплатить»
 * (контакты уезжают тем же запросом), отдельной кнопки нет.
 */

type FieldState = {
  saved: string | null;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
  onEditStart: () => void;
};

type ContactField = {
  field: FieldState;
  /** Поле в валидном состоянии (заполнено или показывает сохранённое). */
  ok: boolean;
  /** Что отправить на сервер (undefined — профиль уже актуален). */
  toSend: string | undefined;
  markSaved: (value: string) => void;
};

function useContactField(
  profileValue: string | null,
  normalize: (raw: string) => string | null,
): ContactField {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  // Локальное «сохранено» поверх пропа: после отправки профиль на сервере уже
  // новый, а проп родителя мог ещё не перечитаться.
  const [savedOverride, setSavedOverride] = useState<string | null>(null);

  const saved = savedOverride ?? profileValue;
  const active = saved === null || editing;
  const normalized = active ? normalize(value) : null;

  return {
    field: {
      saved,
      value,
      editing,
      onChange: setValue,
      onEditStart: () => {
        setValue(saved ?? '');
        setEditing(true);
      },
    },
    ok: !active || normalized !== null,
    toSend: active && normalized !== null && normalized !== saved ? normalized : undefined,
    markSaved: (v: string) => {
      setSavedOverride(v);
      setEditing(false);
      setValue('');
    },
  };
}

export type ContactsState = {
  email: ContactField;
  phone: ContactField;
  /** Отметить успешную отправку: введённые значения становятся «сохранёнными». */
  markSubmitted: () => void;
};

/**
 * Логика плашки, поднятая в хук: и ChatClient, и OrderDetailView считают
 * готовность кнопки оплаты и payload одинаково — дублировать это в двух
 * экранах значит разъехаться на первом же рефакторинге.
 */
export function useContacts(profile: {
  email: string | null;
  phone: string | null;
}): ContactsState {
  const email = useContactField(profile.email, normalizeEmail);
  const phone = useContactField(profile.phone, normalizePhone);
  return {
    email,
    phone,
    markSubmitted: () => {
      if (email.toSend !== undefined) email.markSaved(email.toSend);
      if (phone.toSend !== undefined) phone.markSaved(phone.toSend);
    },
  };
}

function CollapsedRow({
  label,
  value,
  note,
  onEdit,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
          {label}
          {note ? <span className="ml-1.5 normal-case tracking-normal">({note})</span> : null}
        </p>
        <p className="truncate font-body text-sm text-[var(--text)]">{value}</p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 font-display text-sm font-bold text-[var(--link)] underline-offset-2 hover:underline"
      >
        изменить
      </button>
    </div>
  );
}

function InputRow({
  label,
  hint,
  invalidText,
  type,
  placeholder,
  autoComplete,
  field,
  normalize,
  action,
}: {
  label: string;
  hint: string;
  invalidText: string;
  type: 'email' | 'tel';
  placeholder: string;
  autoComplete: string;
  field: FieldState;
  normalize: (raw: string) => string | null;
  action?: React.ReactNode;
}) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && normalize(field.value) === null;
  return (
    <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
      <label className="block">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
          {label}
        </span>
        <input
          type={type}
          inputMode={type}
          autoComplete={autoComplete}
          value={field.value}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder}
          aria-invalid={invalid}
          className={[
            'mt-1.5 w-full rounded-[10px] border-2 bg-[var(--bg)] px-3 py-2 font-body text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none',
            invalid ? 'border-[var(--color-stamp)]' : 'border-[var(--shadow-ink)]',
          ].join(' ')}
        />
      </label>
      {action}
      {invalid ? (
        <p className="mt-1.5 font-body text-xs text-[var(--color-stamp)]">{invalidText}</p>
      ) : (
        <p className="mt-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">{hint}</p>
      )}
    </div>
  );
}

const PHONE_SOURCE_NOTES: Record<string, string> = {
  telegram: 'подтверждён Telegram',
  manual: 'введён вручную',
};

export function phoneSourceNote(source: string | null): string | undefined {
  return source ? PHONE_SOURCE_NOTES[source] : undefined;
}

export function ContactCard({
  contacts,
  phoneRequired,
  phoneRequiredFromRub,
  phoneSource,
  onRequestTelegramPhone,
}: {
  contacts: ContactsState;
  /** Показывать ли поле телефона (сумма от порога). */
  phoneRequired: boolean;
  /** Порог в целых рублях (для подписи поля); null — без цифры. */
  phoneRequiredFromRub: number | null;
  /** Источник сохранённого номера — пометка у свёрнутой строки. */
  phoneSource?: string | null | undefined;
  /** Mini App: «Взять из Telegram» (requestContact). Не задан → кнопки нет. */
  onRequestTelegramPhone?: (() => void) | undefined;
}) {
  const { email, phone } = contacts;
  const emailActive = email.field.saved === null || email.field.editing;
  const phoneActive = phone.field.saved === null || phone.field.editing;

  const telegramButton = onRequestTelegramPhone ? (
    <button
      type="button"
      onClick={onRequestTelegramPhone}
      className="mt-2 w-full rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-1.5 font-display text-sm font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
    >
      Взять из Telegram
    </button>
  ) : undefined;

  return (
    <div className="space-y-2">
      {emailActive ? (
        <InputRow
          label="Почта для связи по заказу"
          hint="Если банк поставит платёж на проверку — напишет сюда. Спросим один раз."
          invalidText={EMAIL_INVALID_TEXT}
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          field={email.field}
          normalize={normalizeEmail}
        />
      ) : (
        <CollapsedRow
          label="Почта для связи"
          value={email.field.saved ?? ''}
          onEdit={email.field.onEditStart}
        />
      )}

      {phoneRequired &&
        (phoneActive ? (
          <InputRow
            label="Телефон плательщика"
            hint={
              phoneRequiredFromRub !== null
                ? phoneFieldHint(phoneRequiredFromRub)
                : 'Банк требует телефон плательщика для этой суммы.'
            }
            invalidText={PHONE_INVALID_TEXT}
            type="tel"
            placeholder="+7 900 000-00-00"
            autoComplete="tel"
            field={phone.field}
            normalize={normalizePhone}
            action={telegramButton}
          />
        ) : (
          <CollapsedRow
            label="Телефон плательщика"
            value={phone.field.saved ?? ''}
            note={phoneSourceNote(phoneSource ?? null)}
            onEdit={phone.field.onEditStart}
          />
        ))}
    </div>
  );
}
