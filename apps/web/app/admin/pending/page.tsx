import Link from 'next/link';

import { getDb, listPendingOrdersForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { RemindPayment } from '@/components/panel/RemindPayment';
import { formatKopecks, orderStatusLabel, orderStatusTone } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { REMIND_BLOCK_TEXT, remindBlockReason, remindGateInput } from '@/lib/panel/remind';

/**
 * `/admin/pending` — заказы, которые клиент оформил и не оплатил (спека §5.5).
 *
 * Зачем экран: из 138 просроченных заказов **97 никогда не дошли до счёта**,
 * ещё 41 счёт получили и не оплатили. Это самая большая денежная потеря.
 *
 * ⚠️ Кнопка отправляет ссылку СУЩЕСТВУЮЩЕГО живого счёта и ничего не создаёт.
 * Там, где напомнить нельзя, вместо кнопки стоит ПРИЧИНА: «кнопки просто нет» —
 * загадка, из-за которой менеджер решит, что панель сломалась.
 */

export const dynamic = 'force-dynamic';

export default async function PanelPendingPage() {
  const access = await panelPageAccess('pending');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/pending" live={false}>
        <PanelForbidden title="Недожатые заказы" />
      </PanelShell>
    );
  }

  const { items, hasMore } = await listPendingOrdersForPanel(getDb());
  const now = new Date();

  return (
    <PanelShell actor={access.actor} current="/admin/pending">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Недожатые заказы</h1>
        <p className="panel-muted">
          Клиент оформил заказ и не заплатил. Напоминание отправляет ссылку уже выставленного
          счёта — новый не создаётся и срок не продлевается. Не чаще раза в сутки на заказ.
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel-card">
          {/* Поток около одного заказа в день: пустой экран — норма. */}
          <p className="panel-empty">Недожатых заказов нет.</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Клиент</th>
                <th>Сервис</th>
                <th>Сумма</th>
                <th>Статус</th>
                <th>Возраст</th>
                <th>Напоминали</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                // Вход гейта собирается ОБЩЕЙ функцией — той же, что зовёт
                // операция. Собери его здесь по-своему, и кнопка появится там,
                // где сервер откажет.
                const blocked = remindBlockReason(remindGateInput(item, now));
                return (
                  <tr key={item.orderId}>
                    <td>
                      <Link href={`/admin/orders/${item.shortId}`}>{item.shortId}</Link>
                    </td>
                    <td>
                      <Link href={`/admin/clients/${item.client.id}`}>
                        {item.client.displayName ?? item.client.telegramId ?? 'без имени'}
                      </Link>
                    </td>
                    <td>{item.serviceName ?? '—'}</td>
                    <td>{formatKopecks(item.amountRubKopecks)}</td>
                    <td>
                      <span className={`panel-status panel-status--${orderStatusTone(item.status)}`}>
                        {orderStatusLabel(item.status)}
                      </span>
                    </td>
                    <td>
                      <LocalAge iso={item.createdAt.toISOString()} />
                      {/* Срок заказа: у черновика это фиксация цены, у
                          выставленного счёта — его собственный TTL. Протухший
                          показываем прямо: заказ доживает до крона (раз в 15
                          минут), и без пометки строка выглядит живой. */}
                      {item.expiresAt ? (
                        <div className="panel-muted">
                          {item.expiresAt.getTime() <= now.getTime() ? (
                            <span className="panel-status panel-status--muted">срок вышел</span>
                          ) : (
                            <>
                              до <LocalTime iso={item.expiresAt.toISOString()} />
                            </>
                          )}
                        </div>
                      ) : null}
                    </td>
                    <td className="panel-muted">
                      {/* ⚠️ Сорванная доставка показывается ВМЕСТО времени
                          отправки: окно суток она съедает, и «напоминали в
                          14:20» там, где клиент ничего не получил, — та же
                          ложь, что «клиенту ушло» на экране холдов. */}
                      {item.lastRemindFailedAt !== null &&
                      (item.lastRemindedAt === null ||
                        item.lastRemindFailedAt > item.lastRemindedAt) ? (
                        <span className="panel-error">
                          не доставлено <LocalTime iso={item.lastRemindFailedAt.toISOString()} />
                        </span>
                      ) : item.lastRemindedAt ? (
                        <LocalTime iso={item.lastRemindedAt.toISOString()} />
                      ) : (
                        'не напоминали'
                      )}
                    </td>
                    <td>
                      {blocked ? (
                        <span className="panel-muted">{REMIND_BLOCK_TEXT[blocked]}</span>
                      ) : (
                        <RemindPayment shortId={item.shortId} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: недожатых заказов больше, чем помещается на экран.
        </p>
      ) : null}
    </PanelShell>
  );
}
