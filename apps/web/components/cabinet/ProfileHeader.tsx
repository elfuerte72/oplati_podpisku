import { formatRub } from '@/components/comic/format';

import type { CabinetProfile } from './cabinet-api';

/**
 * Шапка кабинета: имя клиента + сводка (сколько оплачено заказов, на какую
 * сумму). Контакты (телефон/email) показываем, только если заполнены.
 */
export function ProfileHeader({ profile }: { profile: CabinetProfile }) {
  const name = profile.displayName ?? 'Клиент Оплатишки';
  const contacts = [profile.phone, profile.email].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  return (
    <header
      className={[
        'bg-[var(--surface)] p-5',
        'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]',
      ].join(' ')}
    >
      <p className="font-display text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
        Личный кабинет
      </p>
      <h1 className="mt-1 font-display text-2xl font-bold text-[var(--text)]">{name}</h1>

      {contacts.length > 0 && (
        <p className="mt-1 font-body text-sm text-[var(--text-muted)]">{contacts.join(' · ')}</p>
      )}

      <dl className="mt-4 flex gap-6">
        <div>
          <dt className="font-body text-xs text-[var(--text-muted)]">Оплачено заказов</dt>
          <dd className="font-display text-xl font-bold text-[var(--text)]">{profile.ordersCount}</dd>
        </div>
        <div>
          <dt className="font-body text-xs text-[var(--text-muted)]">На сумму</dt>
          <dd className="font-display text-xl font-bold text-[var(--accent)]">
            {formatRub(profile.totalSpentKopecks)}
          </dd>
        </div>
      </dl>
    </header>
  );
}
