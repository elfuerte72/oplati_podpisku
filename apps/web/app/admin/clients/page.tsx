import type { Metadata } from 'next';
import Link from 'next/link';

import {
  PANEL_DEFAULT_ROWS,
  PANEL_SEARCH_QUERY_MAX_LENGTH,
  countClientSegmentsForPanel,
  getDb,
  listClientsForPanel,
} from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelFilterSelect } from '@/components/panel/PanelFilterSelect';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { ANALYTICS_PERIODS, periodBounds } from '@/lib/panel/analytics/period';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import {
  CLIENT_SEGMENT_OPTIONS,
  CLIENT_SORT_OPTIONS,
  clientsHref,
  parseClientsQuery,
} from '@/lib/panel/client-filters';
import { formatCount, formatKopecks } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  ADDRESS_ERROR_TEXT,
  CELL_TEXT,
  CLIENTS_FILTER_TEXT,
  CLIENT_KIND_LABELS,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  PAGE_HINT,
  PERIOD_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/clients` — все клиенты: кто заходил в бот, кабинет или на сайт, с
 * итогами по заказам и последним следом.
 *
 * До этого экрана клиента можно было открыть только через заказ или быстрый
 * поиск — то есть зная, кого искать. Вопросы «кто купил и не вернулся», «кто
 * оформил и не заплатил», «кому мы должны» требовали SQL на проде.
 *
 * Фильтры, сортировка и страница живут В АДРЕСЕ (как у заказов): ссылку на
 * выборку можно переслать коллеге. Итоги строк считаются в базе, а не по срезу.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.clients };

const KIND_TONE = { buyer: 'ok', tried: 'warn', lurker: 'muted' } as const;

export default async function PanelClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('clients');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/clients" live={false}>
        <PanelForbidden title={SECTION_TITLES.clients} />
      </PanelShell>
    );
  }

  const filters = parseClientsQuery(await searchParams);
  const offset = (filters.page - 1) * PANEL_DEFAULT_ROWS;
  // «Всё время» — умолчание: клиент, зарегистрированный полгода назад и
  // написавший сегодня, не должен исчезать оттого, что фильтр показывает свежих.
  const periodWindow = filters.period ? periodBounds(filters.period, new Date()) : null;
  const base = {
    query: filters.query || undefined,
    createdFrom: periodWindow?.since.toISOString(),
    createdTo: periodWindow?.until.toISOString(),
  };

  const db = getDb();
  // Счётчики сегментов — при тех же поиске и периоде, что и список: иначе над
  // выборкой из одной строки стояло бы «Купили 12».
  const [{ items: clients, hasMore }, counts] = await Promise.all([
    listClientsForPanel(db, {
      ...base,
      segment: filters.segment,
      sort: filters.sort,
      limit: PANEL_DEFAULT_ROWS,
      offset,
    }),
    countClientSegmentsForPanel(db, base),
  ]);

  const linkState = {
    segment: filters.segment,
    query: filters.query,
    sort: filters.sort,
    period: filters.period,
  };
  const filtered = filters.query !== '' || filters.segment !== 'all' || filters.period !== null;

  return (
    <PanelShell actor={access.actor} current="/admin/clients">
      <PanelPageHeader title={SECTION_TITLES.clients}>
        <p className="panel-muted">{PAGE_HINT.clients}</p>

        {/*
         * Поиск, сегмент и два списка — ОДНА форма, как на экране заказов:
         * сортировка и период едут её полями, а без скрипта работает та же
         * кнопка «Найти». Сегмент остался ссылками — это главный срез экрана.
         */}
        <form method="get" className="panel-filters">
          <div className="panel-filters__search">
            <input
              type="search"
              name="q"
              className="panel-input"
              placeholder={CLIENTS_FILTER_TEXT.searchPlaceholder}
              defaultValue={filters.query}
              maxLength={PANEL_SEARCH_QUERY_MAX_LENGTH}
            />
            <button type="submit" className="panel-button">
              {ACTION_TITLES.search}
            </button>
          </div>

          {filters.segment === 'all' ? null : (
            <input type="hidden" name="seg" value={filters.segment} />
          )}

          <div className="panel-filters__tools">
            <nav className="panel-segmented" aria-label={CLIENTS_FILTER_TEXT.segment}>
              {CLIENT_SEGMENT_OPTIONS.map((option) => (
                <Link
                  key={option.key}
                  href={clientsHref({ ...linkState, segment: option.key })}
                  aria-current={option.key === filters.segment ? 'page' : undefined}
                >
                  {option.title} · {formatCount(counts[option.key])}
                </Link>
              ))}
            </nav>

            <div className="panel-filters__selects">
              <PanelFilterSelect
                name="sort"
                value={filters.sort}
                label={CLIENTS_FILTER_TEXT.sort}
                options={CLIENT_SORT_OPTIONS.map((option) => ({
                  value: option.key,
                  title: option.title,
                }))}
              />
              <PanelFilterSelect
                name="period"
                value={filters.period === null ? '' : String(filters.period)}
                label={CLIENTS_FILTER_TEXT.period}
                options={[
                  { value: '', title: CLIENTS_FILTER_TEXT.allTime },
                  ...ANALYTICS_PERIODS.map((days) => ({
                    value: String(days),
                    title: PERIOD_TITLES[days],
                  })),
                ]}
              />
            </div>
          </div>
        </form>

        {filters.ignored.length > 0 ? (
          // Молча проигнорированный параметр — это ссылка, которая у коллеги
          // означает не то же самое, что у отправителя.
          <p className="panel-error" style={{ marginTop: 8 }}>
            {ADDRESS_ERROR_TEXT.ignored} {filters.ignored.join(', ')}. {ADDRESS_ERROR_TEXT.fallback}
          </p>
        ) : null}
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.clients.title}
        hint={HELP_TEXT.clients.hint}
        cards={HELP_TEXT.clients.cards}
      />

      {clients.length === 0 ? (
        <p className="panel-empty">
          {filters.page > 1
            ? EMPTY_TEXT.beyondLastPage
            : filtered
              ? EMPTY_TEXT.clientsFiltered
              : EMPTY_TEXT.clients}
        </p>
      ) : (
        <>
          <div className="panel-table-scroll">
            <table className="panel-table panel-table--cards">
              <thead>
                <tr>
                  <th>{COLUMN_TITLES.client}</th>
                  <th>{COLUMN_TITLES.contacts}</th>
                  <th>{COLUMN_TITLES.registeredAt}</th>
                  <th className="panel-num">{COLUMN_TITLES.ordersCount}</th>
                  <th className="panel-num">{COLUMN_TITLES.purchasesCount}</th>
                  <th className="panel-num">{COLUMN_TITLES.purchased}</th>
                  <th>{COLUMN_TITLES.lastPurchase}</th>
                  <th>{COLUMN_TITLES.lastActivity}</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => {
                  // Исход приходит из репозитория тем же предикатом, что
                  // считает сегменты: пилюля и счётчик над ней не разъедутся.
                  const kind = client.kind;
                  const contacts = [
                    client.hasEmail ? CELL_TEXT.contactEmail : null,
                    client.hasPhone ? CELL_TEXT.contactPhone : null,
                  ].filter((c) => c !== null);
                  return (
                    <tr key={client.id}>
                      <td data-label={COLUMN_TITLES.client}>
                        <Link href={`/admin/clients/${client.id}`}>
                          {client.displayName ?? client.telegramId ?? CELL_TEXT.noName}
                        </Link>
                        <div className="panel-muted">
                          {client.telegramUsername
                            ? `@${client.telegramUsername}`
                            : client.telegramId
                              ? `Telegram ${client.telegramId}`
                              : CELL_TEXT.noTelegram}
                        </div>
                        <div>
                          <span className={STATUS_TONE_CLASS[KIND_TONE[kind]]}>
                            {CLIENT_KIND_LABELS[kind]}
                            {kind === 'buyer' && client.purchasedCount > 1
                              ? ` ×${formatCount(client.purchasedCount)}`
                              : ''}
                          </span>
                          {client.moneyStuck ? (
                            // Заплатил и не получил: пометка стоит в строке, а
                            // не в карточке — это то, ради чего список и открыли.
                            <>
                              {' '}
                              <span className={STATUS_TONE_CLASS.danger}>{CELL_TEXT.moneyStuck}</span>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td data-label={COLUMN_TITLES.contacts} className="panel-muted">
                        {/* Только факт: сами почта и телефон — в карточке.
                            Списку они ни к чему, а PII в разметке на полсотни
                            строк — это PII в кэше браузера и в скриншотах. */}
                        {contacts.length > 0 ? contacts.join(', ') : CELL_TEXT.noContacts}
                      </td>
                      <td data-label={COLUMN_TITLES.registeredAt}>
                        <LocalTime iso={client.createdAt.toISOString()} />
                        <div className="panel-muted">
                          <LocalAge iso={client.createdAt.toISOString()} />
                        </div>
                      </td>
                      <td className="panel-num" data-label={COLUMN_TITLES.ordersCount}>
                        {formatCount(client.ordersCount)}
                      </td>
                      <td className="panel-num" data-label={COLUMN_TITLES.purchasesCount}>
                        {formatCount(client.purchasedCount)}
                      </td>
                      <td className="panel-num" data-label={COLUMN_TITLES.purchased}>
                        {client.purchasedCount > 0 ? formatKopecks(client.purchasedRubKopecks) : '—'}
                      </td>
                      <td data-label={COLUMN_TITLES.lastPurchase}>
                        {client.lastPaidAt ? (
                          <LocalTime iso={client.lastPaidAt.toISOString()} />
                        ) : (
                          <span className="panel-muted">—</span>
                        )}
                      </td>
                      <td data-label={COLUMN_TITLES.lastActivity}>
                        {client.lastActivityAt ? (
                          <>
                            <LocalAge iso={client.lastActivityAt.toISOString()} />
                            <div className="panel-muted">
                              <LocalTime iso={client.lastActivityAt.toISOString()} />
                            </div>
                          </>
                        ) : (
                          <span className="panel-muted">{CELL_TEXT.noTrace}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PanelPager
            page={filters.page}
            hasMore={hasMore}
            hrefFor={(next) => clientsHref({ ...linkState, page: next })}
          />
        </>
      )}
    </PanelShell>
  );
}
