import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getDb, listPartnerReferralsForPanel } from '@oplati/db';

import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatKopecks } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ACTION_TITLES,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  PAGE_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/partners/<userId>` — кого привёл партнёр и сколько эти люди принесли
 * (раскрытие строки списка, спека §5.7).
 *
 * Отдельной страницей, а не раскрывашкой в таблице: раскрывашка потянула бы
 * выборку заказов КАЖДОГО партнёра на общий экран, который вдобавок сам
 * обновляется раз в 25 секунд.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PAGE_TITLES.partner };

const idSchema = z.string().uuid();

export default async function PanelPartnerPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} live={false}>
        <PanelForbidden title={PAGE_TITLES.partner} />
      </PanelShell>
    );
  }

  const { userId } = await params;
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) notFound();

  const { items, hasMore } = await listPartnerReferralsForPanel(getDb(), parsed.data);

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <PanelPageHeader title="Кого привёл партнёр">
        <p className="panel-muted">
          <Link href={`/admin/clients/${parsed.data}`}>{ACTION_TITLES.partnerCard}</Link>
          {' · '}
          <Link href="/admin/partners">{ACTION_TITLES.allPartners}</Link>
        </p>
      </PanelPageHeader>

      {items.length === 0 ? (
        <div className="panel-card">
          <p className="panel-empty">{EMPTY_TEXT.referrals}</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{COLUMN_TITLES.client}</th>
                <th className="panel-num">{COLUMN_TITLES.ordersCount}</th>
                <th className="panel-num">{COLUMN_TITLES.purchased}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((referral) => (
                <tr key={referral.userId}>
                  <td>
                    <Link href={`/admin/clients/${referral.userId}`}>
                      {referral.displayName ?? referral.telegramId ?? CELL_TEXT.noName}
                    </Link>
                  </td>
                  <td className="panel-num">{referral.ordersCount}</td>
                  <td className="panel-num">{formatKopecks(referral.purchasedRubKopecks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: приглашённых больше, чем помещается на экран.
        </p>
      ) : null}
    </PanelShell>
  );
}
