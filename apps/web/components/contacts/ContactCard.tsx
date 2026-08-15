'use client';

import { useState } from 'react';

import { EMAIL_INVALID_TEXT, normalizeEmail } from '@/lib/contacts/email';

/**
 * Плашка контактов на экране заказа (антифрод-трек, тикет 02) — ОДИН компонент
 * на сайт и Mini App (спека §3.2). В пачке 1 в ней только почта; поле телефона
 * добавится в пачке 2.
 *
 * Поведение: почты в профиле нет → обязательное поле с подписью-объяснением;
 * почта есть → строка со значением и кнопкой «изменить». Сохранение — вместе с
 * нажатием «Оплатить» (email уезжает в том же запросе), отдельной кнопки нет.
 */

export type ContactEmailState = {
  /** Пропсы для <ContactCard>. */
  card: {
    savedEmail: string | null;
    email: string;
    editing: boolean;
    onEmailChange: (value: string) => void;
    onEditStart: () => void;
  };
  /** Можно ли жать «Оплатить» (поле заполнено валидно или скрыто). */
  emailOk: boolean;
  /** Что отправить на сервер (undefined — профиль уже актуален). */
  emailToSend: string | undefined;
  /** Отметить успешную отправку: значение стало «сохранённым», поле сложилось. */
  markSaved: (email: string) => void;
};

/**
 * Логика плашки, поднятая в хук: и ChatClient, и OrderDetailView считают
 * готовность кнопки оплаты и payload одинаково — дублировать это в двух
 * экранах значит разъехаться на первом же рефакторинге.
 */
export function useContactEmail(
  profileEmail: string | null,
): ContactEmailState {
  const [email, setEmail] = useState('');
  const [editing, setEditing] = useState(false);
  // Локальное «сохранено» поверх пропа: после успешной оплаты профиль на
  // сервере уже новый, а проп родителя мог ещё не перечитаться.
  const [savedOverride, setSavedOverride] = useState<string | null>(null);

  const savedEmail = savedOverride ?? profileEmail;
  const active = savedEmail === null || editing;
  const normalized = active ? normalizeEmail(email) : null;

  return {
    card: {
      savedEmail,
      email,
      editing,
      onEmailChange: setEmail,
      onEditStart: () => {
        setEmail(savedEmail ?? '');
        setEditing(true);
      },
    },
    emailOk: !active || normalized !== null,
    emailToSend: active && normalized !== null && normalized !== savedEmail ? normalized : undefined,
    markSaved: (value: string) => {
      setSavedOverride(value);
      setEditing(false);
      setEmail('');
    },
  };
}

export function ContactCard({
  savedEmail,
  email,
  editing,
  onEmailChange,
  onEditStart,
}: ContactEmailState['card']) {
  const [touched, setTouched] = useState(false);
  const active = savedEmail === null || editing;

  if (!active) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
            Почта для связи
          </p>
          <p className="truncate font-body text-sm text-[var(--text)]">{savedEmail}</p>
        </div>
        <button
          type="button"
          onClick={onEditStart}
          className="shrink-0 font-display text-sm font-bold text-[var(--link)] underline-offset-2 hover:underline"
        >
          изменить
        </button>
      </div>
    );
  }

  const invalid = touched && normalizeEmail(email) === null;

  return (
    <div className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3.5 py-2.5">
      <label className="block">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
          Почта для связи по заказу
        </span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="you@example.com"
          aria-invalid={invalid}
          className={[
            'mt-1.5 w-full rounded-[10px] border-2 bg-[var(--bg)] px-3 py-2 font-body text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none',
            invalid ? 'border-[var(--color-stamp)]' : 'border-[var(--shadow-ink)]',
          ].join(' ')}
        />
      </label>
      {invalid ? (
        <p className="mt-1.5 font-body text-xs text-[var(--color-stamp)]">{EMAIL_INVALID_TEXT}</p>
      ) : (
        <p className="mt-1.5 font-body text-xs leading-snug text-[var(--text-muted)]">
          Если банк поставит платёж на проверку — напишет сюда. Спросим один раз.
        </p>
      )}
    </div>
  );
}
