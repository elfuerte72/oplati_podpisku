import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listOrdersForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelFilterSelect } from '@/components/panel/PanelFilterSelect';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { formatKopecks, orderStatusLabel, orderStatusTone } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  ORDERS_FILTER_TEXT,
  ORDERS_PERIOD_TEXT,
  PERIOD_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';
import { ANALYTICS_PERIODS, periodBounds } from '@/lib/panel/analytics/period';
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

  // «Всё время» — умолчание: заказ, который завис месяц назад, не должен
  // исчезать с экрана оттого, что фильтр по умолчанию показывает свежее.
  const periodWindow = filters.period ? periodBounds(filters.period, new Date()) : null;

  const { items: orders, hasMore } = await listOrdersForPanel(getDb(), {
    statuses: statuses.length > 0 ? statuses : undefined,
    query: filters.query || undefined,
    sort: filters.sort,
    createdFrom: periodWindow?.since,
    createdTo: periodWindow?.until,
    limit: PANEL_DEFAULT_ROWS,
    offset,
  });

  const linkState = {
    presetKey: filters.preset.key,
    status: filters.status,
    query: filters.query,
    sort: filters.sort,
    period: filters.period,
  };

  return (
    <PanelShell actor={access.actor} current="/admin/orders">
      <PanelPageHeader
        title={SECTION_TITLES.orders}
        aside={
          /*
           * Выгрузка отдаёт ТУ ЖЕ выборку, что на экране, — фильтры едут
           * скрытыми полями. Форма, а не ссылка: в фильтре бывает почта и
           * телефон клиента, а адрес попадает в историю браузера и в
           * `Referer`.
           */
          <form method="post" action="/api/panel/export/orders">
            {filters.query ? <input type="hidden" name="q" value={filters.query} /> : null}
            {filters.preset.key === 'all' ? null : (
              <input type="hidden" name="s" value={filters.preset.key} />
            )}
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            {filters.sort === 'newest' ? null : (
              <input type="hidden" name="sort" value={filters.sort} />
            )}
            {filters.period ? <input type="hidden" name="period" value={filters.period} /> : null}
            <button type="submit" className="panel-button">
              {ACTION_TITLES.exportCsv}
            </button>
          </form>
        }
      >
        {/*
         * Поиск, статус и два списка — ОДНА форма. Сортировка и период едут
         * её полями: сменил значение — форма отправилась, а без скрипта
         * работает та же кнопка «Найти». Статус остался ссылками: это главный
         * срез экрана, и он обязан меняться одним нажатием.
         */}
        <form method="get" className="panel-filters">
          <div className="panel-filters__search">
            <input
              type="search"
              name="q"
              className="panel-input"
              placeholder="Номер заказа, telegram, email, имя"
              defaultValue={filters.query}
              maxLength={100}
            />
            <button type="submit" className="panel-button">
              {ACTION_TITLES.search}
            </button>
          </div>

          {/* Срез статуса едет вместе с поиском: иначе выборка слетает при
              вводе, а пересланная ссылка перестаёт значить то же самое. */}
          {filters.preset.key === 'all' ? null : (
            <input type="hidden" name="s" value={filters.preset.key} />
          )}
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}

          <div className="panel-filters__tools">
            <nav className="panel-segmented" aria-label={ORDERS_FILTER_TEXT.status}>
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

            <div className="panel-filters__selects">
              <PanelFilterSelect
                name="sort"
                value={filters.sort}
                label={ORDERS_FILTER_TEXT.sort}
                options={SORT_OPTIONS.map((option) => ({
                  value: option.key,
                  title: option.title,
                }))}
              />
              <PanelFilterSelect
                name="period"
                // Пустое значение — «всё время»: ключа в адресе тогда нет, и
                // ссылка совпадает с той, по которой в раздел приходят из меню.
                value={filters.period === null ? '' : String(filters.period)}
                label={ORDERS_PERIOD_TEXT.label}
                options={[
                  { value: '', title: ORDERS_PERIOD_TEXT.allTime },
                  ...ANALYTICS_PERIODS.map((days) => ({
                    value: String(days),
                    title: PERIOD_TITLES[days],
                  })),
                ]}
              />
            </div>
          </div>
        </form>

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

      <PanelHelp
        title={HELP_TEXT.orders.title}
        hint={HELP_TEXT.orders.hint}
        cards={HELP_TEXT.orders.cards}
      />

      {orders.length === 0 ? (
        /* Пустой список — норма: на проде живых заказов бывает ноль. */
        <p className="panel-empty">
          {filters.query || statuses.length > 0 || filters.page > 1
            ? EMPTY_TEXT.ordersFiltered
            : EMPTY_TEXT.orders}
        </p>
      ) : (
        <>
          <div className="panel-table-scroll">
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
                        className={STATUS_TONE_CLASS[orderStatusTone(order.status)]}
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

          <PanelPager
            page={filters.page}
            hasMore={hasMore}
            hrefFor={(next) => ordersHref({ ...linkState, page: next })}
          />
        </>
      )}
    </PanelShell>
  );
}
