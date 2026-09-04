import type { Metadata } from 'next';

import { getDb, listStaffForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { panelPageAccess } from '@/lib/panel/guard';
import { COLUMN_TITLES, PAGE_HINT, SECTION_TITLES, STAFF_TEXT } from '@/lib/panel/labels';
import { staffRoleLabel } from '@/lib/panel/roles';

/**
 * `/admin/staff` — раздел «Персонал»: у кого есть доступ в панель.
 *
 * Экран только читает. Заводит и отключает сотрудников скрипт на сервере —
 * форма здесь означала бы второй способ раздавать доступ, мимо того, который
 * уже описан в рунбуке.
 *
 * ⚠️ Наружу не уходит ни второй фактор, ни почта, ни telegram_id: выборка
 * `listStaffForPanel` их не читает вовсе. Экран показывает ФАКТ — привязано ли
 * приложение с кодами и есть ли Telegram, без которого вход не начнётся.
 *
 * Пункт меню виден всем ролям, а право проверяется В ОПЕРАЦИИ: менеджер,
 * набравший адрес руками, получает объясняющую заглушку, а не пустой экран.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.staff };

export default async function PanelStaffPage() {
  const access = await panelPageAccess('staff');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/staff" live={false}>
        <PanelForbidden title={SECTION_TITLES.staff} />
      </PanelShell>
    );
  }

  const members = await listStaffForPanel(getDb());

  return (
    <PanelShell actor={access.actor} current="/admin/staff" live={false}>
      <PanelPageHeader title={SECTION_TITLES.staff}>
        <p className="panel-muted">{PAGE_HINT.staff}</p>
      </PanelPageHeader>

      {members.length === 0 ? (
        /* Пусто — это не поломка: на проде список был пуст до первого
           заведения, и текст объясняет, кто и чем его наполняет. */
        <p className="panel-empty">{STAFF_TEXT.empty}</p>
      ) : (
        <>
          <div className="panel-table-scroll">
            <table className="panel-table panel-table--cards">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.staffMember}</th>
                  <th>{COLUMN_TITLES.role}</th>
                  <th>{COLUMN_TITLES.access}</th>
                  <th>{COLUMN_TITLES.addedAt}</th>
                  <th>{COLUMN_TITLES.lastLoginAt}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td data-label={COLUMN_TITLES.staffMember}>{member.displayName}</td>
                    <td data-label={COLUMN_TITLES.role} className="panel-muted">
                      {staffRoleLabel(member.role)}
                    </td>
                    <td data-label={COLUMN_TITLES.access}>
                      <span className={STATUS_TONE_CLASS[member.isActive ? 'ok' : 'muted']}>
                        {member.isActive ? STAFF_TEXT.accessOn : STAFF_TEXT.accessOff}
                      </span>
                      {/* Незавершённая привязка — не «нет доступа», а «войти
                          пока не получится»: строка живая, вход упрётся во
                          второй фактор. Молчать об этом значило бы отправить
                          владельца искать причину в логах. */}
                      {member.isActive && !member.totpReady ? (
                        <div className="panel-muted">{STAFF_TEXT.totpPending}</div>
                      ) : null}
                      {member.telegramLinked ? null : (
                        <div className="panel-muted">{STAFF_TEXT.telegramMissing}</div>
                      )}
                    </td>
                    <td data-label={COLUMN_TITLES.addedAt} className="panel-muted">
                      <LocalTime iso={member.createdAt.toISOString()} />
                    </td>
                    <td data-label={COLUMN_TITLES.lastLoginAt} className="panel-muted">
                      {member.lastLoginAt ? (
                        <LocalTime iso={member.lastLoginAt.toISOString()} />
                      ) : (
                        STAFF_TEXT.neverLoggedIn
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-muted" style={{ marginTop: 12 }}>
            {STAFF_TEXT.addHint}
          </p>
        </>
      )}
    </PanelShell>
  );
}
