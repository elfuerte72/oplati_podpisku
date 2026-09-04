import type { Metadata } from 'next';
import Link from 'next/link';

import { PANEL_DEFAULT_ROWS, getDb, listReferralPartnersForPanel } from '@oplati/db';

import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { panelOffset, panelPageHref, parsePanelPage } from '@/lib/panel/paging';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  PAGE_HINT,
  SECTION_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/partners` — партнёры и их деньги (спека §5.7).
 *
 * ⚠️ Ставка берётся ТОЛЬКО из `referral_partners.locked_rate_l1_bps` —
 * единственного источника по решению владельца от 11 августа. Панель её
 * показывает и второго места, где ставка живёт, не создаёт.
 *
 * ⚠️ Начисления append-only: суммы отсюда не правятся. Гашение провалившегося
 * заказа делается компенсирующей строкой `reversed`, как сегодня.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.partners };

export default async function PanelPartnersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/partners" live={false}>
        <PanelForbidden title={SECTION_TITLES.partners} />
      </PanelShell>
    );
  }

  const page = parsePanelPage((await searchParams).page);
  const { items, hasMore } = await listReferralPartnersForPanel(getDb(), {
    offset: panelOffset(page, PANEL_DEFAULT_ROWS),
  });

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <PanelPageHeader
        title={SECTION_TITLES.partners}
        aside={<Link href="/admin/partners/payouts">{ACTION_TITLES.payoutRequests}</Link>}
      >
        <p className="panel-muted">{PAGE_HINT.partners}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.partners.title}
        hint={HELP_TEXT.partners.hint}
        cards={HELP_TEXT.partners.cards}
      />

      {items.length === 0 ? (
        /* Программа на soft-start: пустой список — норма. */
        <p className="panel-empty">{EMPTY_TEXT.partners}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{COLUMN_TITLES.partner}</th>
                <th className="panel-num">{COLUMN_TITLES.referralsCount}</th>
                <th className="panel-num">{COLUMN_TITLES.accrued}</th>
                <th className="panel-num">{COLUMN_TITLES.balance}</th>
                <th className="panel-num">{COLUMN_TITLES.rate}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((partner) => (
                <tr key={partner.userId}>
                  <td>
                    <Link href={`/admin/clients/${partner.userId}`}>
                      {partner.displayName ?? partner.telegramId ?? CELL_TEXT.noName}
                    </Link>
                    {partner.suspended ? (
                      <div className="panel-error">{CELL_TEXT.suspended}</div>
                    ) : null}
                  </td>
                  <td className="panel-num">
                    {partner.referralsCount > 0 ? (
                      <Link href={`/admin/partners/${partner.userId}`}>
                        {partner.referralsCount}
                      </Link>
                    ) : (
                      partner.referralsCount
                    )}
                  </td>
                  <td className="panel-num">{formatUsdCents(partner.accruedUsdCents)}</td>
                  <td className="panel-num">{formatUsdCents(partner.balanceUsdCents)}</td>
                  {/* bps → проценты: 400 = 4%. */}
                  <td className="panel-muted panel-num">{(partner.lockedRateL1Bps / 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PanelPager
        page={page}
        hasMore={hasMore}
        hrefFor={(next) => panelPageHref('/admin/partners', {}, next)}
      />
    </PanelShell>
  );
}
