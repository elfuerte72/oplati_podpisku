import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getDb, getOrderDetailForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { ManualFulfillment } from '@/components/panel/ManualFulfillment';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import {
  cardStatusLabel,
  formatKopecks,
  formatOriginalAmount,
  formatUsdCents,
  orderActorLabel,
  orderEventLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentProviderLabel,
  paymentStatusLabel,
  priceBreakdown,
  providerStatusLabel,
} from '@/lib/panel/format';
import {
  canCompleteManualFulfillment,
  canStartManualFulfillment,
  isStartedManually,
} from '@/lib/panel/fulfillment';
import { panelPageAccess } from '@/lib/panel/guard';
import { CELL_TEXT, COLUMN_TITLES, SECTION_TITLES } from '@/lib/panel/labels';
import { canAccess } from '@/lib/panel/permissions';
import { orderShortIdSchema } from '@/lib/panel/order-filters';

/**
 * `/admin/orders/<shortId>` — карточка заказа.
 *
 * Только чтение: кнопки операций приезжают тикетами 06 и 07.
 *
 * ⚠️ Полные `pan`/`cvc` не показываются НИКОГДА — только `pan_masked`.
 * Санкционированных каналов выдачи ровно два (сообщение в Telegram при выпуске
 * и разовый показ в кабинете), панель третьим не становится.
 */

export const dynamic = 'force-dynamic';

/** Вкладка называется номером заказа — иначе пять открытых карточек неотличимы. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ shortId: string }>;
}): Promise<Metadata> {
  const parsed = orderShortIdSchema.safeParse((await params).shortId);
  return { title: parsed.success ? parsed.data.toUpperCase() : SECTION_TITLES.orders };
}

export default async function PanelOrderPage({
  params,
}: {
  params: Promise<{ shortId: string }>;
}) {
  const access = await panelPageAccess('orders');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/orders" live={false}>
        <PanelForbidden title={SECTION_TITLES.orders} />
      </PanelShell>
    );
  }

  // Номер заказа — граница (инвариант 5): проверяем схемой, а не отправляем
  // произвольную строку в запрос. `decodeURIComponent` здесь НЕ нужен — Next
  // отдаёт параметр уже декодированным, а повторный вызов и ронял бы страницу
  // на адресе с одиноким `%`, и склеивал бы разные номера в один.
  const { shortId } = await params;
  const parsedShortId = orderShortIdSchema.safeParse(shortId);
  if (!parsedShortId.success) notFound();

  const detail = await getOrderDetailForPanel(getDb(), parsedShortId.data);
  if (!detail) notFound();

  const { order, client } = detail;
  const price = priceBreakdown(order.amountRubKopecks, order.cardIssueFeeKopecks);

  return (
    <PanelShell actor={access.actor} current="/admin/orders">
      <PanelPageHeader
        title={
          <>
            {order.shortId}{' '}
            <span className={STATUS_TONE_CLASS[orderStatusTone(order.status)]}>
              {orderStatusLabel(order.status)}
            </span>
          </>
        }
      >
        <p className="panel-muted">
          {detail.serviceName ?? CELL_TEXT.serviceNotSpecified} · создан{' '}
          <LocalTime iso={order.createdAt.toISOString()} />
          {order.expiresAt ? (
            <>
              {' '}
              · срок <LocalTime iso={order.expiresAt.toISOString()} />
            </>
          ) : null}
        </p>
      </PanelPageHeader>

      <div className="panel-grid">
        <section className="panel-card">
          <h2 className="panel-title">Клиент</h2>
          <dl className="panel-dl">
            <dt>Имя</dt>
            <dd>
              <Link href={`/admin/clients/${client.id}`}>
                {client.displayName ?? CELL_TEXT.noName}
              </Link>
            </dd>
            <dt>Telegram</dt>
            <dd>
              {client.telegramId ?? (
                // Писать некуда — это надо сказать прямо, а не оставить пустоту.
                <span className="panel-muted">{CELL_TEXT.noTelegram}</span>
              )}
            </dd>
            <dt>Email</dt>
            <dd>{client.email ?? <span className="panel-muted">—</span>}</dd>
            <dt>{COLUMN_TITLES.responsible}</dt>
            <dd>{detail.assignedOperatorName ?? <span className="panel-muted">—</span>}</dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Цена</h2>
          <dl className="panel-dl">
            <dt>Подписка</dt>
            <dd>{price.subscription}</dd>
            <dt>Выпуск карты</dt>
            <dd>{price.fee}</dd>
            <dt>Итого</dt>
            <dd>
              <strong>{price.total}</strong>
            </dd>
            {price.note ? (
              <>
                <dt>Внимание</dt>
                <dd className="panel-muted">{price.note}</dd>
              </>
            ) : null}
            <dt>В валюте сервиса</dt>
            <dd>{formatOriginalAmount(order.originalAmount, order.originalCurrency)}</dd>
            <dt>Комиссия</dt>
            <dd>{order.commissionPercent === null ? '—' : `${order.commissionPercent}%`}</dd>
            <dt>Курс</dt>
            <dd>
              {order.usdtRubRateKopecks === null
                ? '—'
                : `${(order.usdtRubRateKopecks / 10_000).toFixed(4)} ₽`}
            </dd>
          </dl>
        </section>

        <section className="panel-card">
          <h2 className="panel-title">Карта</h2>
          {detail.card ? (
            <dl className="panel-dl">
              <dt>{COLUMN_TITLES.cardNumber}</dt>
              <dd>{detail.card.panMasked}</dd>
              <dt>{COLUMN_TITLES.status}</dt>
              <dd>{cardStatusLabel(detail.card.status)}</dd>
              <dt>{COLUMN_TITLES.cardBalance}</dt>
              <dd>{formatUsdCents(detail.card.balanceUsdCents)}</dd>
              <dt>{COLUMN_TITLES.cardIssuedAt}</dt>
              <dd>
                <LocalTime iso={detail.card.createdAt.toISOString()} />
              </dd>
            </dl>
          ) : (
            <p className="panel-muted">{CELL_TEXT.cardNotIssued}</p>
          )}
        </section>
      </div>

      {/* Ручное исполнение (тикет 06). Кнопка появляется ТОЛЬКО в подходящем
          статусе: разметка действия, которое сервер всё равно отвергнет, лишь
          путает. Право проверяется и здесь, и в самой операции. */}
      {canAccess(access.actor.role, 'fulfillment') &&
      (order.status === 'failed' ||
        canCompleteManualFulfillment(order.status, isStartedManually(detail.events))) ? (
        <section className="panel-card" style={{ marginTop: 16 }}>
          <h2 className="panel-title">Ручное исполнение</h2>
          {order.status === 'failed' ? (
            canStartManualFulfillment(order.status, detail.hasSucceededPayment) ? (
              <>
                <p className="panel-muted">
                  Заказ завершился ошибкой. Если его выдали вручную — отметьте это: пока заказ
                  в статусе «{orderStatusLabel('failed')}», он не учитывается в выручке, а
                  комиссия партнёра по нему погашена.
                </p>
                <ManualFulfillment shortId={order.shortId} action="start" />
              </>
            ) : (
              // Денег по заказу не было (провайдер отверг счёт) либо пришла
              // часть. Отметить такой заказ выданным значило бы записать в
              // выручку то, чего мы не получали.
              <p className="panel-muted">
                Успешного платежа по заказу нет, поэтому вручную выдать его нельзя. Если
                деньги всё-таки пришли — сверьте платёж у провайдера, прежде чем что-то менять.
              </p>
            )
          ) : (
            <>
              <p className="panel-muted">
                Заказ в работе. Отметьте его выданным, когда клиент получил всё, что оплатил.
              </p>
              <ManualFulfillment shortId={order.shortId} action="complete" />
            </>
          )}
        </section>
      ) : null}

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Платежи</h2>
        {detail.payments.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noPayments}</p>
        ) : (
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.provider}</th>
                  <th>{COLUMN_TITLES.invoice}</th>
                  <th className="panel-num">{COLUMN_TITLES.amount}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th>{COLUMN_TITLES.providerStatus}</th>
                  <th>{COLUMN_TITLES.created}</th>
                  <th>{COLUMN_TITLES.paidAt}</th>
                </tr>
              </thead>
              <tbody>
                {detail.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{paymentProviderLabel(payment.provider)}</td>
                    <td className="panel-muted">
                      {payment.providerInvoiceNumber ?? payment.providerRef}
                    </td>
                    <td className="panel-num">{formatKopecks(payment.amountRubKopecks)}</td>
                    <td>{paymentStatusLabel(payment.status)}</td>
                    <td>
                      {providerStatusLabel(payment.lastProviderStatus)}
                      {payment.lastProviderStatusAt ? (
                        <span className="panel-muted">
                          {' '}
                          · <LocalTime iso={payment.lastProviderStatusAt.toISOString()} />
                        </span>
                      ) : null}
                    </td>
                    <td className="panel-muted">
                      <LocalTime iso={payment.createdAt.toISOString()} />
                    </td>
                    <td className="panel-muted">
                      {payment.completedAt ? (
                        <LocalTime iso={payment.completedAt.toISOString()} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-card" style={{ marginTop: 16 }}>
        <h2 className="panel-title">История</h2>
        {detail.events.length === 0 ? (
          <p className="panel-muted">{CELL_TEXT.noEvents}</p>
        ) : (
          <ol className="panel-timeline">
            {detail.events.map((event) => (
              <li key={event.id}>
                <span className="panel-muted">
                  <LocalTime iso={event.createdAt.toISOString()} />
                </span>{' '}
                <strong>{orderEventLabel(event.eventType)}</strong>
                {event.fromStatus || event.toStatus ? (
                  <span>
                    {' '}
                    {orderStatusLabel(event.fromStatus ?? '—')} →{' '}
                    {orderStatusLabel(event.toStatus ?? '—')}
                  </span>
                ) : null}
                {event.actorType ? (
                  <span className="panel-muted"> · {orderActorLabel(event.actorType)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </PanelShell>
  );
}
