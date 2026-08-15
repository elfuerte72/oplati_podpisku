'use client';

import { useState } from 'react';

import { ComicButton } from '@/components/comic/ComicButton';
import { IconArrowLeft } from '@/components/comic/icons';
import { phoneSourceNote } from '@/components/contacts/ContactCard';
import { EMAIL_INVALID_TEXT, normalizeEmail } from '@/lib/contacts/email';
import { PHONE_INVALID_TEXT, normalizePhone } from '@/lib/contacts/phone';

import type { CabinetProfile } from './cabinet-api';

/**
 * Экран «Профиль» в Mini App (антифрод-трек, тикет 08): клиент правит
 * email/телефон в любой момент, не оформляя заказ. Имя из Telegram —
 * read-only (как в ProfilePanel сайта). Ручная правка телефона сбрасывает
 * источник в «введён вручную» (на сервере); «Взять из Telegram» идёт через
 * requestContact — номер придёт боту, экран перечитает профиль.
 */

export type ProfileSaveResult = { ok: true } | { ok: false; message: string };

type Props = {
  profile: CabinetProfile;
  onBack: () => void;
  onSave: (contacts: { email?: string; phone?: string }) => Promise<ProfileSaveResult>;
  /** requestContact SDK; не задан (старый клиент Telegram) → кнопки нет. */
  onRequestTelegramPhone?: (() => void) | undefined;
};

function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-display text-xs font-bold uppercase tracking-wide text-[var(--text)]">
        {label}
        {note ? (
          <span className="ml-1.5 normal-case tracking-normal text-[var(--text-muted)]">
            ({note})
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'mt-1.5 w-full rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2 font-body text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none';

export function ProfileView({ profile, onBack, onSave, onRequestTelegramPhone }: Props) {
  const [email, setEmail] = useState(profile.email ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const save = async () => {
    if (saving) return;
    setNote(null);

    const contacts: { email?: string; phone?: string } = {};
    const emailTrimmed = email.trim();
    if (emailTrimmed && emailTrimmed !== (profile.email ?? '')) {
      const normalized = normalizeEmail(emailTrimmed);
      if (!normalized) {
        setNote({ tone: 'err', text: EMAIL_INVALID_TEXT });
        return;
      }
      contacts.email = normalized;
    }
    const phoneTrimmed = phone.trim();
    if (phoneTrimmed && phoneTrimmed !== (profile.phone ?? '')) {
      const normalized = normalizePhone(phoneTrimmed);
      if (!normalized) {
        setNote({ tone: 'err', text: PHONE_INVALID_TEXT });
        return;
      }
      contacts.phone = normalized;
    }
    if (contacts.email === undefined && contacts.phone === undefined) {
      setNote({ tone: 'ok', text: 'Всё уже сохранено.' });
      return;
    }

    setSaving(true);
    const res = await onSave(contacts);
    setSaving(false);
    setNote(
      res.ok
        ? { tone: 'ok', text: 'Контакты сохранены.' }
        : { tone: 'err', text: res.message },
    );
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

      <div className="space-y-4 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic)]">
        <h2 className="font-display text-xl font-bold text-[var(--text)]">Профиль</h2>

        <Field label="Имя" note="из Telegram">
          <p className="mt-1.5 font-body text-sm text-[var(--text)]">
            {profile.displayName ?? '—'}
          </p>
        </Field>

        <Field label="Почта для связи">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </Field>

        <Field label="Телефон плательщика" note={phoneSourceNote(profile.phoneSource)}>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 900 000-00-00"
            className={inputClass}
          />
        </Field>
        {onRequestTelegramPhone && (
          <button
            type="button"
            onClick={onRequestTelegramPhone}
            className="w-full rounded-[10px] border-2 border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2 font-display text-sm font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            Взять из Telegram
          </button>
        )}

        <ComicButton
          variant="primary"
          className="w-full px-4 py-2.5 text-sm"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </ComicButton>

        {note && (
          <p
            role="status"
            className={[
              'rounded-[12px] border-2 px-3 py-2 font-body text-sm',
              note.tone === 'ok'
                ? 'border-[var(--color-teal-deep)] text-[var(--text)]'
                : 'border-[var(--color-stamp)] text-[var(--color-stamp)]',
            ].join(' ')}
          >
            {note.text}
          </p>
        )}

        <p className="font-body text-xs leading-snug text-[var(--text-muted)]">
          Почта и телефон нужны банку при проверке платежа. Хранятся в профиле и
          передаются только платёжной системе.
        </p>
      </div>
    </div>
  );
}
