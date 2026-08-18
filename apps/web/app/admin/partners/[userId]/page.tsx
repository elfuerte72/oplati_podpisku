import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { getDb, listPartnerReferralsForPanel } from '@oplati/db';

import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { formatKopecks } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';

/**
 * `/admin/partners/<userId>` — кого привёл партнёр и сколько эти люди принесли
 * (раскрытие строки списка, спека §5.7).
 *
 * Отдельной страницей, а не раскрывашкой в таблице: раскрывашка потянула бы
 * выборку заказов КАЖДОГО партнёра на общий экран, который вдобавок сам
 * обновляется раз в 25 секунд.
 */

export const dynamic = 'force-dynamic';

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
        <PanelForbidden title="Партнёр" />
      </PanelShell>
    );
  }

  const { userId } = await params;
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) notFound();

  const { items, hasMore } = await listPartnerReferralsForPanel(getDb(), parsed.data);

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Кого привёл партнёр</h1>
        <p className="panel-muted">
          <Link href={`/admin/clients/${parsed.data}`}>карточка партнёра</Link>
          {' · '}
          <Link href="/admin/partners">все партнёры</Link>
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel-card">
          <p className="panel-empty">Приглашённых нет.</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Заказов</th>
                <th>Оплачено</th>
              </tr>
            </thead>
            <tbody>
              {items.map((referral) => (
                <tr key={referral.userId}>
                  <td>
                    <Link href={`/admin/clients/${referral.userId}`}>
                      {referral.displayName ?? referral.telegramId ?? 'без имени'}
                    </Link>
                  </td>
                  <td>{referral.ordersCount}</td>
                  <td>{formatKopecks(referral.purchasedRubKopecks)}</td>
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
