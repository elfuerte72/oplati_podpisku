import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getClientDetailForPanel, getDb } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import {
  formatKopecks,
  formatUsdCents,
  orderStatusLabel,
  orderStatusTone,
} from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { clientReachability } from '@/lib/panel/reachability';

/**
 * `/admin/clients/<id>` — всё про человека на одной странице (спека §5.3).
 *
 * ⚠️ Полные `pan`/`cvc` не показываются: карты только маскированные.
 *
 * ⚠️ Если у клиента нет Telegram — это написано прямо, и кнопка ответа не
 * рисуется. На проде таких 47 из 103, и «кнопка, которая молча ничего не
 * делает» — худший вариант из возможных.
 */

export const dynamic = 'force-dynamic';

const clientIdSchema = z.string().uuid();

export default async function PanelClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await panelPageAccess('clients');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/orders" live={false}>
        <PanelForbidden title="Клиент" />
      </PanelShell>
    );
  }

  // Идентификатор из адреса — граница (инвариант 5).
  const { id } = await params;
  const parsedId = clientIdSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const detail = await getClientDetailForPanel(getDb(), parsedId.data);
  if (!detail) notFound();

  const { client } = detail;
  const reach = clientReachability(client);
  const totalPaidKopecks = detail.orders
    .filter((o) => o.status === 'completed' || o.status === 'paid' || o.status === 'in_fulfillment')
    .reduce((sum, o) => sum + (o.amountRubKopecks ?? 0), 0);

  return (
    <PanelShell actor={access.actor} current="/admin/orders">
      <div className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">{client.displayName ?? 'Клиент без имени'}</h1>
        <p className="panel-muted">
          {client.telegramId ? `Telegram ${client.telegramId}` : client.hasWebSession ? 'Только сайт' : 'Без канала связи'} · с{' '}
          <LocalTime iso={client.createdAt.toISOString()} />
        </p>
        {reach.reachable ? null : (
          <p className="panel-error" style={{ marginTop: 8 }}>
            {reach.reason}: клиент оформил заказ на сайте и Telegram не привязал.
          </p>
        )}
      </div>

      <div className="panel-grid">
        <section className="panel-card">
          <h2 className="panel-title">Контакты</h2>
          {/* На проде 101 из 103 клиентов без email — пустые контакты это
              норма, а не сбой, и экран не должен выглядеть сломанным. */}
          <dl className="panel-dl">
            <dt>Email</dt>
            <dd>{client.email ?? <span className="panel-muted">не оставлял</span>}</dd>
            <dt>Телефон</dt>
            <dd>
              {client.phone ?? <span className="panel-muted">не оставлял</span>}
              {client.phone && client.phoneSource ? (
                <span className="panel-muted">
                  {' '}
                  ·{' '}
                  {client.phoneSource === 'telegram'
                    ? 'из Telegram, верифицирован'
                    : 'введён руками'}
                </span>
              ) : null}
            </dd>
            <dt>Язык</dt>
            <dd>{client.language}</dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Итоги</h2>
          <dl className="panel-dl">
            <dt>Заказов</dt>
            <dd>{detail.orders.length}</dd>
            <dt>Оплачено</dt>
            <dd>{formatKopecks(totalPaidKopecks)}</dd>
            <dt>Карт</dt>
            <dd>{detail.cards.length}</dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Партнёрские связи</h2>
          <dl className="panel-dl">
            <dt>Кто привёл</dt>
            <dd>
              {detail.referredBy ? (
                <Link href={`/admin/clients/${detail.referredBy.id}`}>
                  {detail.referredBy.displayName ??
                    detail.referredBy.telegramId ??
                    'без имени'}
                </Link>
              ) : (
                <span className="panel-muted">никто</span>
              )}
            </dd>
            <dt>Кого привёл</dt>
            <dd>
              {detail.referrals.length === 0 ? (
                <span className="panel-muted">никого</span>
              ) : (
                detail.referrals.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/admin/clients/${r.id}`}>
                      {r.displayName ?? r.telegramId ?? 'без имени'}
                    </Link>
                  </span>
                ))
              )}
            </dd>
          </dl>
        </section>
      </div>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Заказы</h2>
        {detail.orders.length === 0 ? (
          <p className="panel-muted">Заказов не было.</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Сервис</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/admin/orders/${order.shortId}`}>{order.shortId}</Link>
                    </td>
                    <td>{order.serviceName ?? '—'}</td>
                    <td>{formatKopecks(order.amountRubKopecks)}</td>
                    <td>
                      <span
                        className={`panel-status panel-status--${orderStatusTone(order.status)}`}
                      >
                        {orderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td className="panel-muted">
                      <LocalTime iso={order.createdAt.toISOString()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Карты</h2>
        {detail.cards.length === 0 ? (
          <p className="panel-muted">Карт не выпускалось.</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Статус</th>
                  <th>Баланс</th>
                  <th>Выпущена</th>
                </tr>
              </thead>
              <tbody>
                {detail.cards.map((card) => (
                  <tr key={card.id}>
                    <td>{card.panMasked}</td>
                    <td>{card.status}</td>
                    <td>{formatUsdCents(card.balanceUsdCents)}</td>
                    <td className="panel-muted">
                      <LocalTime iso={card.createdAt.toISOString()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelShell>
  );
}
