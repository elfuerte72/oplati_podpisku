'use client';

import { useCallback, useEffect, useState } from 'react';

import { formatRub } from '@/components/comic';
import { Mascot, type MascotPose } from './Mascot';
import { useTelegramLink } from './TelegramLink';

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

type ProfileResponse = { ok: boolean; profile?: Profile };

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
 * Свободно стоит на фоне панели (ассет с прозрачным фоном, без рамок),
 * анимируется по состоянию диалога: думает / показывает / радуется.
 * Ниже — профиль из БД (/api/profile): имя из Telegram, привязка,
 * число оплаченных заказов и сумма трат. Обновляется после привязки
 * (linkPhase) и после оплаты (PROFILE_REFRESH_EVENT из ChatClient).
 */
export function ProfilePanel({
  pose,
  onPoke,
  quip,
  typing = false,
}: {
  pose: MascotPose;
  onPoke?: () => void;
  quip?: string | null;
  typing?: boolean;
}) {
  const { phase: linkPhase, start: startLink } = useTelegramLink({ checkOnMount: true });
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(() => {
    void fetch('/api/profile')
      .then((res) => res.json() as Promise<ProfileResponse>)
      .then((data) => {
        if (data.ok && data.profile) setProfile(data.profile);
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
    <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-4 lg:flex">
      {/* Маскот — свободно, без плашки */}
      <div className="relative flex flex-col items-center gap-1 pt-3">
        {quip && (
          <span className="absolute -top-1 z-10 whitespace-nowrap rounded-[14px] rounded-bl-[4px] border-2 border-[var(--shadow-ink)] bg-[var(--bubble-bot)] px-3 py-1.5 font-body text-sm text-[var(--text)] shadow-[var(--shadow-comic)] motion-safe:animate-[comic-pop_180ms_var(--ease-pop)_both]">
            {quip}
          </span>
        )}
        <Mascot pose={pose} size={160} onPoke={onPoke} />
        <span className="font-display text-lg font-bold text-[var(--text)]">Оплатишка</span>
        <span className="font-body text-xs text-[var(--text-muted)]" role="status">
          {typing ? 'печатает…' : 'твой помощник по оплате'}
        </span>
      </div>

      {/* Mock личного профиля */}
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
    </aside>
  );
}
