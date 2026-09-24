'use client';

import { useState } from 'react';

import { formatRub, formatSinceMonth, formatUsd } from '@/components/comic/format';
import { IconArrowRight } from '@/components/comic/icons';
import { track } from '@/lib/analytics/client';
import { copyToClipboard } from '@/lib/clipboard';
import { telegramShareLink } from '@/lib/telegram/links';

import type { CabinetProfile } from './cabinet-api';

/**
 * Вкладка «Профиль» (трек miniapp-tabs, тикет 09), вид — `mockup/Profile.dc.html`.
 *
 * Решение владельца: партнёрская программа живёт здесь, первым блоком, а не
 * занимает половину главного экрана у клиента без единой покупки. Карточка
 * реф-ссылки перенесена из прежнего главного экрана как есть — копирование с
 * честным отказом буфера и шеринг через Telegram.
 */

const sectionTitle =
  'font-body text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]';

function IconCopy() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function IconPlane() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12l16-8-6 16-3-7-7-1z" />
    </svg>
  );
}

function IconQuestion() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5h16v11H9l-5 4V5z" />
    </svg>
  );
}

export function ProfileTab({
  profile,
  referralLink,
  phoneRequiredFromRub,
  onOpenPartner,
  onEditContacts,
  onOpenIntro,
  onContactSupport,
  onShare,
}: {
  profile: CabinetProfile;
  /** Реф-ссылка; `null` — программа выключена, блока нет. */
  referralLink: string | null;
  phoneRequiredFromRub: number | null;
  onOpenPartner: () => void;
  onEditContacts: () => void;
  onOpenIntro: () => void;
  /** Закрыть Mini App — клиент попадает в чат бота. Не задан — пункта нет. */
  onContactSupport?: (() => void) | undefined;
  /** Открыть шеринг Telegram (или окно браузера вне Telegram). */
  onShare: (url: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const name = profile.displayName?.trim() || 'Клиент';
  const initial = name.charAt(0).toUpperCase();
  const since = formatSinceMonth(profile.memberSince);
  const bonus =
    profile.bonusBalanceUsdCents != null && profile.bonusBalanceUsdCents > 0
      ? profile.bonusBalanceUsdCents
      : null;

  const copyLink = () => {
    if (!referralLink) return;
    void copyToClipboard(referralLink).then((ok) => {
      // Трек по результату: отказ буфера не считается «скопировал».
      track('referral_link_share', { action: ok ? 'copy' : 'copy_failed', surface: 'cabinet_profile' });
      setCopyFailed(!ok);
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }
    });
  };

  const share = () => {
    if (!referralLink) return;
    track('referral_link_share', { action: 'share', surface: 'cabinet_profile' });
    onShare(
      telegramShareLink(
        referralLink,
        'Оплачиваю иностранные подписки в рублях через Оплатишку — попробуй!',
      ),
    );
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex items-center gap-3 pt-1">
        <span
          aria-hidden
          className="flex size-[52px] shrink-0 items-center justify-center rounded-full border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-deep)] font-display text-[22px] font-bold text-[var(--color-paper)]"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <h1 className="truncate font-display text-[26px] leading-tight font-bold text-[var(--text)]">{name}</h1>
          {since && (
            <p className="mt-0.5 font-body text-sm text-[var(--text-muted)]">в Оплатишке с {since}</p>
          )}
        </div>
      </header>

      {referralLink && (
        <section className="flex flex-col gap-3 rounded-[18px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 shadow-[var(--shadow-comic)]">
          <h2 className="font-display text-xl font-bold text-[var(--text)]">Зови друзей — получай процент</h2>
          <p className="font-body text-sm text-[var(--text-muted)]">
            Друг открывает бота по твоей ссылке и закрепляется за тобой.
          </p>
          <p
            // Поле со ссылкой — выделяемый текст и зона без свайпа вкладок:
            // палец, выделяющий ссылку, не должен листать приложение.
            data-swipe-ignore
            className="rounded-[12px] border-2 border-[var(--shadow-ink)] bg-[var(--bg)] px-3 py-2.5 font-body text-sm font-semibold break-all text-[var(--accent)] select-all"
          >
            {referralLink}
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={copyLink}
              className="flex min-h-[50px] items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-3 py-2.5 font-display text-base font-bold text-[var(--color-paper)] shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
            >
              {copied ? 'Скопировано' : 'Скопировать'}
              <IconCopy />
            </button>
            <button
              type="button"
              onClick={share}
              className="flex min-h-[50px] items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-3 py-2.5 font-display text-[15px] font-bold text-[var(--text)] shadow-[3px_3px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <IconPlane />
              Поделиться
            </button>
          </div>
          {copyFailed && (
            <p role="alert" className="font-body text-xs text-[var(--color-stamp)]">
              Не удалось скопировать. Выдели ссылку выше и скопируй вручную.
            </p>
          )}
          {bonus !== null && (
            <>
              <div className="border-t-2 border-dashed border-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]" />
              <div className="flex justify-between gap-3 font-body text-[15px]">
                <span className="text-[var(--text-muted)]">Баллы</span>
                <span className="tabular-nums text-[var(--text)]">{formatUsd(bonus)}</span>
              </div>
              <p className="font-body text-[13px] text-[var(--text-muted)]">
                Можно списать при оплате своего заказа.
              </p>
            </>
          )}
          <button
            type="button"
            onClick={onOpenPartner}
            className="inline-flex min-h-10 items-center gap-1 self-start font-body text-sm text-[var(--accent)]"
          >
            Подробнее о программе
            <IconArrowRight size={14} />
          </button>
        </section>
      )}

      <section className="flex flex-col">
        <h2 className={`${sectionTitle} mb-1`}>Контакты</h2>
        <ContactRow
          label="Почта"
          value={profile.email}
          emptyText="Не указана · нужна для оплаты"
          onEdit={onEditContacts}
          divider
        />
        <ContactRow
          label="Телефон"
          value={profile.phone}
          emptyText={
            phoneRequiredFromRub !== null
              ? `Не указан · нужен для заказов от ${formatRub(phoneRequiredFromRub * 100)}`
              : 'Не указан'
          }
          onEdit={onEditContacts}
        />
      </section>

      <section className="flex flex-col">
        <h2 className={sectionTitle}>Помощь</h2>
        <HelpRow icon={<IconQuestion />} title="Как это работает" onClick={onOpenIntro} />
        {onContactSupport && (
          <HelpRow
            icon={<IconChat />}
            title="Написать в поддержку"
            hint="откроется чат с ботом"
            onClick={onContactSupport}
          />
        )}
      </section>
    </div>
  );
}

function ContactRow({
  label,
  value,
  emptyText,
  onEdit,
  divider = false,
}: {
  label: string;
  value: string | null;
  emptyText: string;
  onEdit: () => void;
  divider?: boolean;
}) {
  return (
    <div
      className={[
        'flex min-h-[52px] items-center gap-3',
        divider ? 'border-b border-[color-mix(in_srgb,var(--text-muted)_20%,transparent)]' : '',
      ].join(' ')}
    >
      <span className="min-w-0 flex-1 py-1.5">
        <span className="block font-body text-xs text-[var(--text-muted)]">{label}</span>
        <span
          className={[
            'block font-body text-[15px]',
            // Значение — одной строкой (длинная почта обрезается), подсказка
            // про порог — переносом: её конец и есть смысл.
            value ? 'truncate text-[var(--text)]' : 'text-[var(--text-muted)]',
          ].join(' ')}
        >
          {value ?? emptyText}
        </span>
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="min-h-10 shrink-0 px-1 font-body text-sm text-[var(--accent)]"
      >
        {value ? 'Изменить' : 'Добавить'}
      </button>
    </div>
  );
}

function HelpRow({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 py-1.5 text-left"
    >
      <span className="flex text-[var(--accent)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-body text-[15px] font-medium text-[var(--text)]">{title}</span>
        {hint && <span className="block font-body text-[13px] text-[var(--text-muted)]">{hint}</span>}
      </span>
      <IconArrowRight size={18} className="shrink-0 text-[var(--text-muted)]" />
    </button>
  );
}
