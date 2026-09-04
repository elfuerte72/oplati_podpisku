import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listReferralPayoutsForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { PayoutDecision } from '@/components/panel/PayoutDecision';
import { formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { panelOffset, panelPageHref, parsePanelPage } from '@/lib/panel/paging';
import { ACTION_TITLES, CELL_TEXT, COLUMN_TITLES, EMPTY_TEXT } from '@/lib/panel/labels';
import { isPayoutDecidable, payoutStatusLabel } from '@/lib/panel/payouts';

/**
 * `/admin/partners/payouts` — заявки на вывод (спека §5.7, §6.4).
 *
 * ⚠️ Панель фиксирует ФАКТ выплаты, а деньги по-прежнему уходят вручную:
 * `settlePayout` — mock и нигде не вызывается. Это написано прямо на экране,
 * иначе кнопка «выплачено» читается как «перевести».
 *
 * ⚠️ Кнопка «отклонить» нужна с первого дня: статус `rejected` не ставит
 * сегодня ни одна живая строка кода, а сумма заявки вычитается из баланса —
 * первая же необработанная заявка замораживает деньги партнёра навсегда.
 *
 * По умолчанию показываем ТОЛЬКО открытые заявки (`requested`/`processing`) —
 * это рабочий список, а не архив; закрытые копятся навсегда и вытеснили бы
 * живые за потолок выборки. Полный список — по адресу `?all=1`.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: ACTION_TITLES.payoutRequests };

export default async function PanelPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/partners" live={false}>
        <PanelForbidden title={ACTION_TITLES.payoutRequests} />
      </PanelShell>
    );
  }

  const query = await searchParams;
  const showAll = query.all === '1';
  const page = parsePanelPage(query.page);
  const { items, hasMore } = await listReferralPayoutsForPanel(getDb(), {
    onlyOpen: !showAll,
    offset: panelOffset(page, PANEL_DEFAULT_ROWS),
  });

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <PanelPageHeader
        title={ACTION_TITLES.payoutRequests}
        aside={
          showAll ? (
            <Link href="/admin/partners/payouts">{ACTION_TITLES.onlyOpen}</Link>
          ) : (
            <Link href="/admin/partners/payouts?all=1">{ACTION_TITLES.showClosed}</Link>
          )
        }
      >
        <p className="panel-muted">
          Панель фиксирует факт: деньги переводятся вручную, автоматической выплаты нет.
          «{ACTION_TITLES.payoutPaid}» ставит статус, «{ACTION_TITLES.payoutReject}» возвращает
          сумму в баланс партнёра. <Link href="/admin/partners">{ACTION_TITLES.allPartners}</Link>
        </p>
      </PanelPageHeader>

      {items.length === 0 ? (
        /* На 16 августа заявок было ноль — пустой экран это норма. */
        <p className="panel-empty">{showAll ? EMPTY_TEXT.payouts : EMPTY_TEXT.payoutsOpen}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{COLUMN_TITLES.partner}</th>
                <th className="panel-num">{COLUMN_TITLES.amount}</th>
                <th>{COLUMN_TITLES.method}</th>
                <th>{COLUMN_TITLES.status}</th>
                <th>{COLUMN_TITLES.requestedAt}</th>
                <th className="panel-num">{COLUMN_TITLES.balanceNow}</th>
                <th>{COLUMN_TITLES.action}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((payout) => (
                <tr key={payout.payoutId}>
                  <td>
                    <Link href={`/admin/clients/${payout.userId}`}>
                      {payout.displayName ?? payout.telegramId ?? CELL_TEXT.noName}
                    </Link>
                    {/* Заявку заблокированного партнёра выплатить нельзя — гейт
                        стоит в операции, но узнать об этом ДО нажатия честнее. */}
                    {payout.suspended ? (
                      <div className="panel-error">{CELL_TEXT.suspended}</div>
                    ) : null}
                  </td>
                  <td className="panel-num">
                    {formatUsdCents(payout.amountUsdCents)}
                    {payout.feeUsdCents !== null && payout.feeUsdCents > 0 ? (
                      <div className="panel-muted">
                        {CELL_TEXT.payoutFee} {formatUsdCents(payout.feeUsdCents)}
                      </div>
                    ) : null}
                  </td>
                  <td className="panel-muted">{payout.method ?? CELL_TEXT.notSpecified}</td>
                  <td>{payoutStatusLabel(payout.status)}</td>
                  <td className="panel-muted">
                    <LocalTime iso={payout.requestedAt.toISOString()} />
                  </td>
                  <td className={payout.balanceUsdCents < 0 ? 'panel-num panel-error' : 'panel-num'}>
                    {formatUsdCents(payout.balanceUsdCents)}
                  </td>
                  <td>
                    {isPayoutDecidable(payout.status) ? (
                      <PayoutDecision payoutId={payout.payoutId} suspended={payout.suspended} />
                    ) : (
                      <span className="panel-muted">
                        {payout.settledAt ? <LocalTime iso={payout.settledAt.toISOString()} /> : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ключ `all=1` едет вместе со страницей: иначе «Дальше» из полного
          списка возвращало бы на срез открытых заявок. */}
      <PanelPager
        page={page}
        hasMore={hasMore}
        hrefFor={(next) =>
          panelPageHref('/admin/partners/payouts', { all: showAll ? '1' : undefined }, next)
        }
      />
    </PanelShell>
  );
}
