import Link from 'next/link';

import { getDb, listReferralPartnersForPanel } from '@oplati/db';

import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';

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

export default async function PanelPartnersPage() {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/partners" live={false}>
        <PanelForbidden title="Партнёры" />
      </PanelShell>
    );
  }

  const { items, hasMore } = await listReferralPartnersForPanel(getDb());

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Партнёры</h1>
        <p className="panel-muted">
          Баланс — это начислено минус отменённое минус заявки на вывод. Суммы начислений руками
          не правятся: журнал append-only.{' '}
          <Link href="/admin/partners/payouts">Заявки на вывод</Link>
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel-card">
          {/* Программа на soft-start: пустой список — норма. */}
          <p className="panel-empty">Партнёров пока нет.</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Партнёр</th>
                <th>Привёл</th>
                <th>Начислено всего</th>
                <th>Баланс</th>
                <th>Ставка</th>
              </tr>
            </thead>
            <tbody>
              {items.map((partner) => (
                <tr key={partner.userId}>
                  <td>
                    <Link href={`/admin/clients/${partner.userId}`}>
                      {partner.displayName ?? partner.telegramId ?? 'без имени'}
                    </Link>
                    {partner.suspended ? (
                      <div className="panel-error">заблокирован антифродом</div>
                    ) : null}
                  </td>
                  <td>
                    {partner.referralsCount > 0 ? (
                      <Link href={`/admin/partners/${partner.userId}`}>
                        {partner.referralsCount}
                      </Link>
                    ) : (
                      partner.referralsCount
                    )}
                  </td>
                  <td>{formatUsdCents(partner.accruedUsdCents)}</td>
                  <td>{formatUsdCents(partner.balanceUsdCents)}</td>
                  {/* bps → проценты: 400 = 4%. */}
                  <td className="panel-muted">{(partner.lockedRateL1Bps / 100).toFixed(2)}%</td>
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
