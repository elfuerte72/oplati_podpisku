import Link from 'next/link';

import { getDb, listReferralPayoutsForPanel } from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { PayoutDecision } from '@/components/panel/PayoutDecision';
import { formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
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

export default async function PanelPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('partners');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/partners" live={false}>
        <PanelForbidden title="Заявки на вывод" />
      </PanelShell>
    );
  }

  const showAll = (await searchParams).all === '1';
  const { items, hasMore } = await listReferralPayoutsForPanel(getDb(), { onlyOpen: !showAll });

  return (
    <PanelShell actor={access.actor} current="/admin/partners">
      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h1 className="panel-title">Заявки на вывод</h1>
        <p className="panel-muted">
          Панель фиксирует факт: деньги переводятся ВРУЧНУЮ, автоматической выплаты нет.
          «Выплачено» ставит статус, «Отклонить» возвращает сумму в баланс партнёра.{' '}
          <Link href="/admin/partners">партнёры</Link>
          {' · '}
          {showAll ? (
            <Link href="/admin/partners/payouts">только открытые</Link>
          ) : (
            <Link href="/admin/partners/payouts?all=1">показать закрытые</Link>
          )}
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel-card">
          {/* На 16 августа заявок было ноль — пустой экран это норма. */}
          <p className="panel-empty">{showAll ? 'Заявок нет.' : 'Открытых заявок нет.'}</p>
        </div>
      ) : (
        <div className="panel-card panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Партнёр</th>
                <th>Сумма</th>
                <th>Способ</th>
                <th>Статус</th>
                <th>Подана</th>
                <th>Баланс сейчас</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {items.map((payout) => (
                <tr key={payout.payoutId}>
                  <td>
                    <Link href={`/admin/clients/${payout.userId}`}>
                      {payout.displayName ?? payout.telegramId ?? 'без имени'}
                    </Link>
                    {/* Заявку заблокированного партнёра выплатить нельзя — гейт
                        стоит в операции, но узнать об этом ДО нажатия честнее. */}
                    {payout.suspended ? (
                      <div className="panel-error">заблокирован антифродом</div>
                    ) : null}
                  </td>
                  <td>
                    {formatUsdCents(payout.amountUsdCents)}
                    {payout.feeUsdCents !== null && payout.feeUsdCents > 0 ? (
                      <div className="panel-muted">
                        комиссия вывода {formatUsdCents(payout.feeUsdCents)}
                      </div>
                    ) : null}
                  </td>
                  <td className="panel-muted">{payout.method ?? 'не указан'}</td>
                  <td>{payoutStatusLabel(payout.status)}</td>
                  <td className="panel-muted">
                    <LocalTime iso={payout.requestedAt.toISOString()} />
                  </td>
                  <td className={payout.balanceUsdCents < 0 ? 'panel-error' : undefined}>
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

      {hasMore ? (
        <p className="panel-muted" style={{ marginTop: 12 }}>
          Показаны не все: заявок больше, чем помещается на экран.
        </p>
      ) : null}
    </PanelShell>
  );
}
