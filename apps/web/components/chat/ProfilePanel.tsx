'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { formatRub } from '@/components/comic';
import { fetchWithTimeout } from '@/lib/http';
import { Mascot, type MascotPose } from './Mascot';
import { TelegramIcon, useTelegramLink } from './TelegramLink';

/**
 * Событие «статистика могла измениться» (оплата заказа в ChatClient) —
 * панель профиля перезагружает данные из /api/profile.
 */
export const PROFILE_REFRESH_EVENT = 'oplatishka:profile-refresh';

type Profile = {
  displayName: string | null;
  telegramLinked: boolean;
  ordersCount: number;
  totalSpentKopecks: number;
};

type ProfileResponse = { ok: boolean; profile?: Profile; supportUrl?: string | null };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-body text-sm text-[var(--text-muted)]">{label}</span>
      <span className="font-body text-sm font-semibold text-[var(--text)]">{value}</span>
    </div>
  );
}

/**
 * Правая панель: крупный Оплатишка — единственный маскот на десктопе.
 * Ниже — профиль из БД (/api/profile): имя из Telegram, привязка, число
 * оплаченных заказов, сумма трат + кнопки «Привязать Telegram» и «Поддержка».
 * Обновляется после привязки (linkPhase) и после оплаты (PROFILE_REFRESH_EVENT).
 *
 * Адаптив: на десктопе (lg+) — статичный сайдбар; на мобильном — выезжающая
 * справа панель (drawer), управляется `open`/`onClose` из ChatClient. Это
 * чинит баг «на телефоне не видно профиль / кнопку привязки Telegram»: раньше
 * панель была `hidden lg:flex` и на мобильном пропадала целиком.
 */
export function ProfilePanel({
  pose,
  typing = false,
  open = false,
  onClose,
}: {
  pose: MascotPose;
  typing?: boolean;
  open?: boolean;
  onClose?: () => void;
}) {
  const { phase: linkPhase, start: startLink } = useTelegramLink({ checkOnMount: true });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);

  // На мобильном закрытый drawer уезжает off-screen (translate-x-full), но
  // остаётся в DOM — прячем его от скринридеров/таб-навигации через inert.
  // На десктопе (lg+) панель статична и всегда интерактивна → inert не ставим.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const loadProfile = useCallback(() => {
    void fetchWithTimeout('/api/profile')
      .then((res) => res.json() as Promise<ProfileResponse>)
      .then((data) => {
        if (data.ok && data.profile) setProfile(data.profile);
        setSupportUrl(data.supportUrl ?? null);
      })
      .catch(() => {
        // профиль не критичен — останутся значения по умолчанию
      });
  }, []);

  useEffect(() => {
    loadProfile();
    window.addEventListener(PROFILE_REFRESH_EVENT, loadProfile);
    return () => window.removeEventListener(PROFILE_REFRESH_EVENT, loadProfile);
  }, [loadProfile]);

  // После привязки в БД появляется имя из Telegram — перечитываем профиль.
  useEffect(() => {
    if (linkPhase === 'linked') loadProfile();
  }, [linkPhase, loadProfile]);

  const displayName = profile?.displayName ?? null;

  return (
    <>
      {/* Затемнение под drawer — только мобильный, закрывает по тапу. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          aria-hidden
          onClick={onClose}
        />
      )}

      <aside
        className={[
          'flex w-80 max-w-[85vw] shrink-0 flex-col gap-4 overflow-y-auto border-l-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4',
          // Мобильный: выезжающая справа панель (вне потока, off-screen когда закрыта).
          'fixed inset-y-0 right-0 z-40 shadow-[var(--shadow-comic)] transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
          // Десктоп: статичный сайдбар, всегда видим.
          'lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:shadow-none',
        ].join(' ')}
        aria-label="Личный профиль"
        {...(!isDesktop && !open ? { inert: true } : {})}
      >
        {/* Закрыть — только мобильный drawer. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть профиль"
          className="grid h-9 w-9 shrink-0 place-items-center self-end rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none lg:hidden"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>

        {/* Маскот — свободно, без плашки; статичный, реагирует только сменой позы */}
        <div className="relative flex flex-col items-center gap-1 pt-1 lg:pt-3">
          <Mascot pose={pose} size={160} />
          <span className="wordmark mt-1 font-display text-2xl font-bold leading-none">Оплатишка</span>
          {typing && (
            <span className="font-body text-xs text-[var(--text-muted)]" role="status">
              печатает…
            </span>
          )}
        </div>

        {/* Личный профиль */}
        <div className="space-y-3 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] p-4 shadow-[var(--shadow-comic)]">
          <h3 className="font-display font-bold text-[var(--text)]">Личный профиль</h3>
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--bg)] font-display text-lg font-bold text-[var(--text)]">
              {(displayName ?? 'Гость').slice(0, 1).toUpperCase()}
            </span>
            <div className="leading-tight">
              <span className="block font-display font-bold text-[var(--text)]">
                {displayName ?? 'Гость'}
              </span>
              <span className="font-body text-xs text-[var(--text-muted)]">
                {linkPhase === 'linked' ? 'аккаунт привязан к Telegram' : 'без регистрации'}
              </span>
            </div>
          </div>
          <div className="space-y-1.5 border-t-2 border-[var(--shadow-ink)] pt-3">
            <Row label="Заказов" value={String(profile?.ordersCount ?? 0)} />
            <Row label="Потрачено" value={formatRub(profile?.totalSpentKopecks ?? 0)} />
            <Row
              label="Telegram"
              value={
                linkPhase === 'linked' ? 'привязан' : linkPhase === 'unknown' ? '…' : 'не привязан'
              }
            />
          </div>
          {linkPhase !== 'linked' && (
            <button
              type="button"
              onClick={() => void startLink()}
              disabled={linkPhase === 'unknown' || linkPhase === 'starting' || linkPhase === 'waiting'}
              className="w-full rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-2 font-display font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-70"
            >
              {linkPhase === 'starting'
                ? 'Открываю Telegram…'
                : linkPhase === 'waiting'
                  ? 'Жду подтверждения…'
                  : linkPhase === 'error'
                    ? 'Не вышло — ещё раз'
                    : 'Привязать Telegram'}
            </button>
          )}
        </div>

        {/* Партнёрская программа — десктоп открывает кабинет /partner; мобильный
            браузер страница /partner сама уводит в Telegram (мини-апп). */}
        <Link
          href="/partner"
          className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-2.5 font-display font-bold text-[var(--color-paper)] shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
        >
          🤝 Партнёрская программа
        </Link>

        {/* Telegram — открывает бота (deep-link на /start: приветствие + меню). */}
        {supportUrl && (
          <a
            href={supportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface-2)] px-4 py-2 font-display font-bold text-[var(--text)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            <TelegramIcon className="h-4 w-4 shrink-0" />
            Telegram
          </a>
        )}
      </aside>
    </>
  );
}
