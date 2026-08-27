import type { Metadata } from 'next';
import Link from 'next/link';

import { getDb, listReferralPartnersForPanel } from '@oplati/db';

import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
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

export default async function PanelPartnersPage() {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/partners" live={false}>
        <PanelForbidden title={SECTION_TITLES.partners} />
      </PanelShell>
    );
  }

  const { items, hasMore } = await listReferralPartnersForPanel(getDb());

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <PanelPageHeader
        title={SECTION_TITLES.partners}
        aside={<Link href="/admin/partners/payouts">{ACTION_TITLES.payoutRequests}</Link>}
      >
        <p className="panel-muted">
          Баланс — это начислено минус отменённое минус заявки на выплату. Суммы начислений
          вручную не правятся: журнал только дописывается.
        </p>
      </PanelPageHeader>

      {items.length === 0 ? (
        <div className="panel-card">
          {/* Программа на soft-start: пустой список — норма. */}
          <p className="panel-empty">{EMPTY_TEXT.partners}</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
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

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: партнёров больше, чем помещается на экран.
        </p>
      ) : null}
    </PanelShell>
  );
}
