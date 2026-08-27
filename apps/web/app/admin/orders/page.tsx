import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listOrdersForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatKopecks, orderStatusLabel, orderStatusTone } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  SECTION_TITLES,
} from '@/lib/panel/labels';
import {
  SORT_OPTIONS,
  STATUS_PRESETS,
  ordersHref,
  parseOrdersQuery,
} from '@/lib/panel/order-filters';

/**
 * `/admin/orders` — список заказов.
 *
 * Фильтры, сортировка и страница живут В АДРЕСЕ (спека §5.2): ссылку на нужную
 * выборку можно переслать коллеге, а не пересказывать словами, куда нажать.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.orders };

export default async function PanelOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('orders');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/orders" live={false}>
        <PanelForbidden title={SECTION_TITLES.orders} />
      </PanelShell>
    );
  }

  const filters = parseOrdersQuery(await searchParams);
  // Точечный статус из адреса перебивает пресет: по такой ссылке приходят из
  // других экранов панели.
  const statuses = filters.status ? [filters.status] : filters.preset.statuses;
  const offset = (filters.page - 1) * PANEL_DEFAULT_ROWS;

  const { items: orders, hasMore } = await listOrdersForPanel(getDb(), {
    statuses: statuses.length > 0 ? statuses : undefined,
    query: filters.query || undefined,
    sort: filters.sort,
    limit: PANEL_DEFAULT_ROWS,
    offset,
  });

  const linkState = {
    presetKey: filters.preset.key,
    status: filters.status,
    query: filters.query,
    sort: filters.sort,
  };

  return (
    <PanelShell actor={access.actor} current="/admin/orders">
      <PanelPageHeader title={SECTION_TITLES.orders}>
        <form method="get" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input
            type="search"
            name="q"
            className="panel-input"
            placeholder="Номер заказа, telegram, email, имя"
            defaultValue={filters.query}
            maxLength={100}
            style={{ minWidth: 260, flex: 1 }}
          />
          {/* Фильтр и сортировка едут вместе с поиском: иначе выборка слетает
              при вводе, а пересланная ссылка перестаёт значить то же самое. */}
          {filters.preset.key === 'all' ? null : (
            <input type="hidden" name="s" value={filters.preset.key} />
          )}
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          {filters.sort === 'newest' ? null : (
            <input type="hidden" name="sort" value={filters.sort} />
          )}
          <button type="submit" className="panel-button">
            {ACTION_TITLES.search}
          </button>
        </form>

        <nav className="panel-nav" style={{ marginTop: 12 }}>
          {STATUS_PRESETS.map((preset) => (
            <Link
              key={preset.key}
              href={ordersHref({ ...linkState, presetKey: preset.key, status: null })}
              aria-current={
                preset.key === filters.preset.key && !filters.status ? 'page' : undefined
              }
            >
              {preset.title}
            </Link>
          ))}
        </nav>

        <nav className="panel-nav" style={{ marginTop: 4 }}>
          <span className="panel-muted" style={{ padding: '4px 10px' }}>
            Сортировка:
          </span>
          {SORT_OPTIONS.map((option) => (
            <Link
              key={option.key}
              href={ordersHref({ ...linkState, sort: option.key })}
              aria-current={option.key === filters.sort ? 'page' : undefined}
            >
              {option.title}
            </Link>
          ))}
        </nav>

        {filters.status ? (
          <p className="panel-muted" style={{ marginTop: 8 }}>
            Фильтр по статусу: {orderStatusLabel(filters.status)}.{' '}
            <Link href={ordersHref({ ...linkState, status: null })}>{ACTION_TITLES.clearFilter}</Link>
          </p>
        ) : null}

        {filters.ignored.length > 0 ? (
          // Молча проигнорированный параметр — это ссылка, которая у коллеги
          // означает не то же самое, что у отправителя.
          <p className="panel-error" style={{ marginTop: 8 }}>
            Не удалось разобрать параметры адреса: {filters.ignored.join(', ')}. Показана
            выборка по умолчанию.
          </p>
        ) : null}
      </PanelPageHeader>

      {orders.length === 0 ? (
        <div className="panel-card">
          {/* Пустой список — норма: на проде живых заказов бывает ноль. */}
          <p className="panel-empty">
            {filters.query || statuses.length > 0 || filters.page > 1
              ? EMPTY_TEXT.ordersFiltered
              : EMPTY_TEXT.orders}
          </p>
        </div>
      ) : (
        <>
          <div className="panel-card panel-table-scroll">
            <table className="panel-table panel-table--cards">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.order}</th>
                  <th>{COLUMN_TITLES.client}</th>
                  <th>{COLUMN_TITLES.service}</th>
                  <th className="panel-num">{COLUMN_TITLES.amount}</th>
                  <th>{COLUMN_TITLES.status}</th>
                  <th>{COLUMN_TITLES.created}</th>
                  <th>{COLUMN_TITLES.responsible}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td data-label={COLUMN_TITLES.order}>
                      <Link href={`/admin/orders/${order.shortId}`}>{order.shortId}</Link>
                    </td>
                    <td data-label={COLUMN_TITLES.client}>
                      <Link href={`/admin/clients/${order.client.id}`}>
                        {order.client.displayName ?? order.client.telegramId ?? CELL_TEXT.noName}
                      </Link>
                      {order.client.telegramId ? null : (
                        // 47 клиентов из 103 без Telegram: менеджеру важно
                        // видеть это в списке, а не выяснять на карточке.
                        <span className="panel-muted"> · {CELL_TEXT.noTelegramShort}</span>
                      )}
                    </td>
                    <td data-label={COLUMN_TITLES.service}>{order.serviceName ?? '—'}</td>
                    <td className="panel-num" data-label={COLUMN_TITLES.amount}>
                      {formatKopecks(order.amountRubKopecks)}
                    </td>
                    <td data-label={COLUMN_TITLES.status}>
                      <span
                        className={`panel-status panel-status--${orderStatusTone(order.status)}`}
                      >
                        {orderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td data-label={COLUMN_TITLES.created}>
                      {/* Одна колонка вместо «Возраст» + «Создан»: точное
                          местное время — то, что сверяют с рассказом клиента
                          («оплатил 20-го около 14:30»), возраст — под ним. */}
                      <LocalTime iso={order.createdAt.toISOString()} />
                      <div className="panel-muted">
                        <LocalAge iso={order.createdAt.toISOString()} />
                      </div>
                    </td>
                    <td data-label={COLUMN_TITLES.responsible} className="panel-muted">{order.assignedOperatorName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Усечение выборки проговаривается вслух: страница без продолжения
              читалась бы как «это все заказы». */}
          <div
            className="panel-card"
            style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}
          >
            <span className="panel-muted">
              Страница {filters.page}
              {hasMore ? ', есть ещё' : ''}
            </span>
            {filters.page > 1 ? (
              <Link href={ordersHref({ ...linkState, page: filters.page - 1 })}>
                {ACTION_TITLES.prevPage}
              </Link>
            ) : null}
            {hasMore ? (
              <Link href={ordersHref({ ...linkState, page: filters.page + 1 })}>
                {ACTION_TITLES.nextPage}
              </Link>
            ) : null}
          </div>
        </>
      )}
    </PanelShell>
  );
}
