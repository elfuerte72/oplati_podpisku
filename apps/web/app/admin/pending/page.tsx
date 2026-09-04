import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listPendingOrdersForPanel } from '@oplati/db';

import { LocalAge, LocalTime } from '@/components/panel/LocalTime';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { RemindPayment } from '@/components/panel/RemindPayment';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { formatKopecks, orderStatusLabel, orderStatusTone } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  PAGE_HINT,
  REMIND_BLOCK_TEXT,
  SECTION_TITLES,
} from '@/lib/panel/labels';
import { panelOffset, panelPageHref, parsePanelPage } from '@/lib/panel/paging';
import { remindBlockReason, remindGateInput } from '@/lib/panel/remind';

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

export const metadata: Metadata = { title: SECTION_TITLES.pending };

export default async function PanelPendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('pending');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/pending" live={false}>
        <PanelForbidden title={SECTION_TITLES.pending} />
      </PanelShell>
    );
  }

  const page = parsePanelPage((await searchParams).page);
  const { items, hasMore } = await listPendingOrdersForPanel(getDb(), {
    offset: panelOffset(page, PANEL_DEFAULT_ROWS),
  });
  const now = new Date();

  return (
    <PanelShell actor={access.actor} current="/admin/pending">
      <PanelPageHeader title={SECTION_TITLES.pending}>
        <p className="panel-muted">{PAGE_HINT.pending}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.pending.title}
        hint={HELP_TEXT.pending.hint}
        cards={HELP_TEXT.pending.cards}
      />

      {items.length === 0 ? (
        /* Поток около одного заказа в день: пустой экран — норма. */
        <p className="panel-empty">{page > 1 ? EMPTY_TEXT.beyondLastPage : EMPTY_TEXT.pending}</p>
      ) : (
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
                <th>{COLUMN_TITLES.reminded}</th>
                <th>{COLUMN_TITLES.action}</th>
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
                    <td data-label={COLUMN_TITLES.order}>
                      <Link href={`/admin/orders/${item.shortId}`}>{item.shortId}</Link>
                    </td>
                    <td data-label={COLUMN_TITLES.client}>
                      <Link href={`/admin/clients/${item.client.id}`}>
                        {item.client.displayName ?? item.client.telegramId ?? CELL_TEXT.noName}
                      </Link>
                    </td>
                    <td data-label={COLUMN_TITLES.service}>{item.serviceName ?? '—'}</td>
                    <td className="panel-num" data-label={COLUMN_TITLES.amount}>
                      {formatKopecks(item.amountRubKopecks)}
                    </td>
                    <td data-label={COLUMN_TITLES.status}>
                      <span className={STATUS_TONE_CLASS[orderStatusTone(item.status)]}>
                        {orderStatusLabel(item.status)}
                      </span>
                    </td>
                    <td data-label={COLUMN_TITLES.created}>
                      <LocalAge iso={item.createdAt.toISOString()} />
                      {/* Срок заказа: у черновика это фиксация цены, у
                          выставленного счёта — его собственный TTL. Протухший
                          показываем прямо: заказ доживает до крона (раз в 15
                          минут), и без пометки строка выглядит живой. */}
                      {item.expiresAt ? (
                        <div className="panel-muted">
                          {item.expiresAt.getTime() <= now.getTime() ? (
                            <span className="panel-status panel-status--muted">
                              {CELL_TEXT.expired}
                            </span>
                          ) : (
                            <>
                              до <LocalTime iso={item.expiresAt.toISOString()} />
                            </>
                          )}
                        </div>
                      ) : null}
                    </td>
                    <td data-label={COLUMN_TITLES.reminded} className="panel-muted">
                      {/* ⚠️ Сорванная доставка показывается ВМЕСТО времени
                          отправки: окно суток она съедает, и «напоминали в
                          14:20» там, где клиент ничего не получил, — та же
                          ложь, что «клиенту ушло» на экране холдов. */}
                      {item.lastRemindFailedAt !== null &&
                      (item.lastRemindedAt === null ||
                        item.lastRemindFailedAt > item.lastRemindedAt) ? (
                        <span className="panel-error">
                          {CELL_TEXT.notDelivered}{' '}
                          <LocalTime iso={item.lastRemindFailedAt.toISOString()} />
                        </span>
                      ) : item.lastRemindedAt ? (
                        <LocalTime iso={item.lastRemindedAt.toISOString()} />
                      ) : (
                        CELL_TEXT.notReminded
                      )}
                    </td>
                    <td className="panel-wrap" data-label={COLUMN_TITLES.action}>
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

      <PanelPager
        page={page}
        hasMore={hasMore}
        hrefFor={(next) => panelPageHref('/admin/pending', {}, next)}
      />
    </PanelShell>
  );
}
