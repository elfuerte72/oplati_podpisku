import Link from 'next/link';

import { getDb, listSupportRequestsForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/support` — обращения клиентов (спека §5.6).
 *
 * Единица списка — РАЗГОВОР, а не сообщение: «кто ведёт» и «подключиться»
 * живут на `conversations`. Обращение создаётся ТОЛЬКО нажатием кнопки или
 * командой `/support` (правило владельца) — свободный текст обращением не
 * становится, и панель показывает ровно то, что клиент отправил намеренно.
 */

export const dynamic = 'force-dynamic';

export default async function PanelSupportPage() {
  const access = await panelPageAccess('support');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/support" live={false}>
        <PanelForbidden title="Поддержка" />
      </PanelShell>
    );
  }

  const { items, hasMore } = await listSupportRequestsForPanel(getDb());

  return (
    <PanelShell actor={access.actor} current="/admin/support">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Поддержка</h1>
        <p className="panel-muted">
          Клиент нажал «Поддержка» или написал <code>/support</code>. Ответ приходит ему от бота —
          что за ботом человек, клиент не знает.
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel-card">
          {/* Четыре обращения за три месяца — пустой экран это норма. */}
          <p className="panel-empty">Обращений нет.</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Написал</th>
                <th>Ответили</th>
                <th>Кто ведёт</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.conversationId}>
                  <td>
                    <Link href={`/admin/clients/${item.client.id}`}>
                      {item.client.displayName ?? item.client.telegramId ?? 'без имени'}
                    </Link>
                    {item.lastRequestDelivered ? null : (
                      // Обращение не дошло до оператора — это наша авария
                      // конфигурации, а клиент считает, что написал.
                      <div className="panel-error">не доставлено оператору</div>
                    )}
                  </td>
                  <td>
                    <LocalAge iso={item.lastRequestAt.toISOString()} /> назад
                  </td>
                  <td className={item.lastOperatorReplyAt ? 'panel-muted' : undefined}>
                    {item.lastOperatorReplyAt ? (
                      <LocalTime iso={item.lastOperatorReplyAt.toISOString()} />
                    ) : (
                      <span className="panel-status panel-status--warn">не отвечали</span>
                    )}
                  </td>
                  <td className="panel-muted">{item.assignedOperatorName ?? '—'}</td>
                  <td>
                    <Link href={`/admin/support/${item.conversationId}`}>Открыть</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: обращений больше, чем помещается на экран.
        </p>
      ) : null}
    </PanelShell>
  );
}
