import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getClientDetailForPanel, getDb } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import {
  cardStatusLabel,
  formatKopecks,
  formatUsdCents,
  orderStatusLabel,
  orderStatusTone,
} from '@/lib/panel/format';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { panelPageAccess } from '@/lib/panel/guard';
import { CELL_TEXT, COLUMN_TITLES, PAGE_TITLES } from '@/lib/panel/labels';
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

export const metadata: Metadata = { title: PAGE_TITLES.client };

const clientIdSchema = z.string().uuid();

export default async function PanelClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await panelPageAccess('clients');
  if (!access.allowed) {
    // `current` не задан намеренно: карточка клиента не пункт меню, и подсветка
    // «Заказы» на ней говорила бы человеку, что он в другом разделе.
    return (
      <PanelShell actor={access.actor} live={false}>
        <PanelForbidden title={PAGE_TITLES.client} />
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
  // Список заказов режется потолком выборки, поэтому итоги берутся ИЗ БАЗЫ
  // (`detail.totals`), а не складываются по видимым строкам: у клиента со 100+
  // заказами сумма по срезу молча занижала бы деньги, а «Заказов» показывало бы
  // ровно потолок.
  const hiddenOrders = detail.totals.ordersCount - detail.orders.length;

  return (
    <PanelShell actor={access.actor}>
      <PanelPageHeader title={client.displayName ?? CELL_TEXT.clientNoName}>
        <p className="panel-muted">
          {client.telegramId ? `Telegram ${client.telegramId}` : client.hasWebSession ? 'Только сайт' : 'Без канала связи'} · с{' '}
          <LocalTime iso={client.createdAt.toISOString()} />
        </p>
        {reach.reachable ? null : (
          <p className="panel-error" style={{ marginTop: 8 }}>
            {reach.reason}: клиент оформил заказ на сайте и Telegram не привязал.
          </p>
        )}
      </PanelPageHeader>

      <div className="panel-grid">
        <section className="panel-card">
          <h2 className="panel-title">Контакты</h2>
          {/* На проде 101 из 103 клиентов без email — пустые контакты это
              норма, а не сбой, и экран не должен выглядеть сломанным. */}
          <dl className="panel-dl">
            <dt>Email</dt>
            <dd>{client.email ?? <span className="panel-muted">{CELL_TEXT.notLeft}</span>}</dd>
            <dt>Телефон</dt>
            <dd>
              {client.phone ?? <span className="panel-muted">{CELL_TEXT.notLeft}</span>}
              {client.phone && client.phoneSource ? (
                <span className="panel-muted">
                  {' '}
                  ·{' '}
                  {client.phoneSource === 'telegram'
                    ? CELL_TEXT.phoneFromTelegram
                    : CELL_TEXT.phoneManual}
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
            <dd>{detail.totals.ordersCount}</dd>
            <dt>Оплачено</dt>
            <dd>{formatKopecks(detail.totals.purchasedRubKopecks)}</dd>
            <dt>Карт</dt>
            <dd>{detail.totals.cardsCount}</dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Партнёрство</h2>
          <dl className="panel-dl">
            <dt>Кто привёл</dt>
            <dd>
              {detail.referredBy ? (
                <Link href={`/admin/clients/${detail.referredBy.id}`}>
                  {detail.referredBy.displayName ??
                    detail.referredBy.telegramId ??
                    CELL_TEXT.noName}
                </Link>
              ) : (
                <span className="panel-muted">{CELL_TEXT.none}</span>
              )}
            </dd>
            <dt>Кого привёл</dt>
            <dd>
              {detail.referrals.length === 0 ? (
                <span className="panel-muted">{CELL_TEXT.nobody}</span>
              ) : (
                detail.referrals.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/admin/clients/${r.id}`}>
                      {r.displayName ?? r.telegramId ?? CELL_TEXT.noName}
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
          <p className="panel-muted">{CELL_TEXT.noOrders}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.order}</th>
                  <th>{COLUMN_TITLES.service}</th>
                  <th className="panel-num">{COLUMN_TITLES.amount}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th>{COLUMN_TITLES.created}</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/admin/orders/${order.shortId}`}>{order.shortId}</Link>
                    </td>
                    <td>{order.serviceName ?? '—'}</td>
                    <td className="panel-num">{formatKopecks(order.amountRubKopecks)}</td>
                    <td>
                      <span
                        className={STATUS_TONE_CLASS[orderStatusTone(order.status)]}
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
        {hiddenOrders > 0 ? (
          // Усечение проговаривается вслух: молчаливый срез читается как «это
          // все заказы клиента» и врёт тем сильнее, чем ценнее клиент.
          // Отправлять в общий список намеренно НЕ обещаем: фильтра по клиенту
          // там нет, а поиск умеет только номер, telegram, email и имя — у
          // веб-клиента без контактов искать нечем.
          <p className="panel-muted" style={{ marginTop: 8 }}>
            Показаны последние {detail.orders.length} из {detail.totals.ordersCount}; ещё{' '}
            {hiddenOrders} не помещаются на экран.
          </p>
        ) : null}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Карты</h2>
        {detail.cards.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noCards}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.cardNumber}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th className="panel-num">{COLUMN_TITLES.cardBalance}</th>
                  <th>{COLUMN_TITLES.cardIssuedAt}</th>
                </tr>
              </thead>
              <tbody>
                {detail.cards.map((card) => (
                  <tr key={card.id}>
                    <td>{card.panMasked}</td>
                    <td>{cardStatusLabel(card.status)}</td>
                    <td className="panel-num">{formatUsdCents(card.balanceUsdCents)}</td>
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
