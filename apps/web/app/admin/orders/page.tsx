import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listOrdersForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatKopecks, orderStatusLabel, orderStatusTone } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
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

export default async function PanelOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('orders');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/orders" live={false}>
        <PanelForbidden title="Заказы" />
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
      <div className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Заказы</h1>

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
            Найти
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
            Точечный фильтр по статусу: {orderStatusLabel(filters.status)}.{' '}
            <Link href={ordersHref({ ...linkState, status: null })}>снять</Link>
          </p>
        ) : null}

        {filters.ignored.length > 0 ? (
          // Молча проигнорированный параметр — это ссылка, которая у коллеги
          // означает не то же самое, что у отправителя.
          <p className="panel-error" style={{ marginTop: 8 }}>
            Не понял параметры адреса: {filters.ignored.join(', ')}. Показываю выборку по
            умолчанию.
          </p>
        ) : null}
      </div>

      {orders.length === 0 ? (
        <div className="panel-card">
          {/* Пустой список — норма: на проде живых заказов бывает ноль. */}
          <p className="panel-empty">
            {filters.query || statuses.length > 0 || filters.page > 1
              ? 'По этому фильтру заказов нет.'
              : 'Заказов пока нет.'}
          </p>
        </div>
      ) : (
        <>
          <div className="panel-card panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Клиент</th>
                  <th>Сервис</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Возраст</th>
                  <th>Создан</th>
                  <th>Ведёт</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/admin/orders/${order.shortId}`}>{order.shortId}</Link>
                    </td>
                    <td>
                      <Link href={`/admin/clients/${order.client.id}`}>
                        {order.client.displayName ?? order.client.telegramId ?? 'без имени'}
                      </Link>
                      {order.client.telegramId ? null : (
                        // 47 клиентов из 103 без Telegram: менеджеру важно
                        // видеть это в списке, а не выяснять на карточке.
                        <span className="panel-muted"> · без Telegram</span>
                      )}
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
                    <td>
                      <LocalAge iso={order.createdAt.toISOString()} />
                    </td>
                    <td className="panel-muted">
                      <LocalTime iso={order.createdAt.toISOString()} />
                    </td>
                    <td className="panel-muted">{order.assignedOperatorName ?? '—'}</td>
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
              <Link href={ordersHref({ ...linkState, page: filters.page - 1 })}>Назад</Link>
            ) : null}
            {hasMore ? (
              <Link href={ordersHref({ ...linkState, page: filters.page + 1 })}>Дальше</Link>
            ) : null}
          </div>
        </>
      )}
    </PanelShell>
  );
}
