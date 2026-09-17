import type { Metadata } from 'next';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { STATUS_TONE_CLASS } from '@/lib/panel/class-names';
import { formatKopecks, formatUsdCents } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { CELL_TEXT, HELP_TEXT, PAGE_HINT, SECTION_TITLES, TREASURY_TEXT } from '@/lib/panel/labels';
import type { AccountBalanceEntry } from '@/lib/pay-space/client';
import type { FundTopUpPlan } from '@/lib/pay-space/fund-plan';
import {
  hasFunds,
  readTreasuryForPanel,
  type FreekassaWithdrawalRow,
  type ProviderReading,
  type TreasuryReport,
} from '@/lib/panel/treasury';

/**
 * `/admin/treasury` — «Финансы» (трек treasury, тикет 01): остатки на трёх
 * счетах и что из карточного фонда свободно.
 *
 * Экран только читает. Живое обновление выключено: цифры держатся в кэше
 * минуту, а каждое чтение Freekassa тратит nonce из общей с платежами очереди
 * — раз в 25 секунд дёргать провайдеров ради справочной страницы незачем.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.treasury };

export default async function PanelTreasuryPage() {
  const access = await panelPageAccess('treasury');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/treasury" live={false}>
        <PanelForbidden title={SECTION_TITLES.treasury} />
      </PanelShell>
    );
  }

  const report = await readTreasuryForPanel();

  return (
    <PanelShell actor={access.actor} current="/admin/treasury" live={false}>
      <PanelPageHeader title={SECTION_TITLES.treasury}>
        <p className="panel-muted">{PAGE_HINT.treasury}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.treasury.title}
        hint={HELP_TEXT.treasury.hint}
        cards={HELP_TEXT.treasury.cards}
      />

      <div className="panel-grid">
        <VccCard report={report} />
        <CryptoCard reading={report.payspace} />
        <FkWalletCard reading={report.fkwallet} />
        <FreekassaCard reading={report.freekassa} />
      </div>

      <WithdrawalsTable reading={report.freekassa} />
    </PanelShell>
  );
}

/** Карточный счёт: остаток, обязательства, свободно — одной карточкой. */
function VccCard({ report }: { report: TreasuryReport }) {
  const { vcc, fund, freeUsdCents } = report;
  return (
    <section className="panel-card">
      <h2 className="panel-title">{TREASURY_TEXT.vccTitle}</h2>
      {vcc.state === 'ok' || vcc.state === 'stale' ? (
        <>
          <p>
            <span className={`${STATUS_TONE_CLASS[vcc.low ? 'danger' : 'ok']} panel-status--lg`}>
              {formatUsdCents(vcc.balanceUsdCents)}
            </span>
            {vcc.state === 'stale' ? (
              <>
                {' '}
                <span className="panel-status panel-status--warn">
                  {TREASURY_TEXT.staleFrom} <LocalTime iso={vcc.readAt.toISOString()} />,{' '}
                  {TREASURY_TEXT.staleSuffix}
                </span>
              </>
            ) : null}
          </p>
          <dl className="panel-dl">
            <dt>{TREASURY_TEXT.pending}</dt>
            <dd>{formatUsdCents(vcc.pendingUsdCents)}</dd>
            {fund.state === 'ok' ? (
              <>
                <dt>{TREASURY_TEXT.committed}</dt>
                <dd>{formatUsdCents(fund.committedUsdCents)}</dd>
                <dt>{TREASURY_TEXT.reserved}</dt>
                <dd>{formatUsdCents(fund.reservedUsdCents)}</dd>
                {fund.safetyReserveUsdCents > 0 ? (
                  <>
                    <dt>{TREASURY_TEXT.safety}</dt>
                    <dd>{formatUsdCents(fund.safetyReserveUsdCents)}</dd>
                  </>
                ) : null}
              </>
            ) : null}
            <dt>{TREASURY_TEXT.free}</dt>
            <dd>
              {freeUsdCents === null ? (
                <span className="panel-muted">{TREASURY_TEXT.fundUnavailable}</span>
              ) : (
                <span
                  className={
                    STATUS_TONE_CLASS[freeUsdCents < vcc.thresholdUsdCents ? 'danger' : 'ok']
                  }
                >
                  {/* Отрицательное «свободно» — ноль на экране, дыра — строкой ниже. */}
                  {formatUsdCents(Math.max(0, freeUsdCents))}
                </span>
              )}
            </dd>
            <dt>{TREASURY_TEXT.threshold}</dt>
            <dd>
              {vcc.thresholdUsdCents > 0
                ? formatUsdCents(vcc.thresholdUsdCents)
                : CELL_TEXT.thresholdNotSetAlertOff}
            </dd>
          </dl>
          {freeUsdCents !== null && freeUsdCents < 0 ? (
            <p className="panel-error">
              {TREASURY_TEXT.overcommitted} {formatUsdCents(-freeUsdCents)}
            </p>
          ) : null}
          <p className="panel-muted">{TREASURY_TEXT.freeNote}</p>
          <TopUpAdvice plan={report.topUp} />
        </>
      ) : vcc.state === 'unavailable' ? (
        <p className="panel-muted">{CELL_TEXT.balanceUnavailable}</p>
      ) : (
        <p className="panel-muted">{CELL_TEXT.balanceNotConfigured}</p>
      )}
    </section>
  );
}

/** Крипто-кошельки PaySpace: только непустые, с оценкой в долларах и итогом. */
function CryptoCard({ reading }: { reading: TreasuryReport['payspace'] }) {
  return (
    <section className="panel-card">
      <h2 className="panel-title">{TREASURY_TEXT.cryptoTitle}</h2>
      {reading.state === 'ok' || reading.state === 'stale' ? (
        <>
          <p>
            <span className="panel-status panel-status--ok panel-status--lg">
              {formatUsdCents(reading.data.totalUsdCents)}
            </span>{' '}
            <span className="panel-muted">{TREASURY_TEXT.total}</span>
          </p>
          {reading.data.balances.filter(hasFunds).length === 0 ? (
            <p className="panel-empty">{TREASURY_TEXT.noCrypto}</p>
          ) : (
            <dl className="panel-dl">
              {reading.data.balances.filter(hasFunds).map((wallet) => (
                <WalletRow key={wallet.id} wallet={wallet} />
              ))}
            </dl>
          )}
          <ReadingNote reading={reading} />
        </>
      ) : (
        <ProviderFallback reading={reading} />
      )}
    </section>
  );
}

function WalletRow({ wallet }: { wallet: AccountBalanceEntry }) {
  return (
    <>
      <dt>
        {wallet.code}
        {wallet.chain ? <span className="panel-muted"> · {wallet.chain}</span> : null}
      </dt>
      <dd>
        {wallet.amount} <span className="panel-muted">≈ {formatUsdCents(wallet.fiatUsdCents)}</span>
      </dd>
    </>
  );
}

/**
 * «Сколько пополнить» — по норме рунбука. Числа приходят из расчёта, экран их
 * только подписывает; при достаточном остатке одна строка вместо таблицы.
 */
function TopUpAdvice({ plan }: { plan: FundTopUpPlan | null }) {
  if (plan === null) return null;
  if (plan.state === 'enough') {
    return (
      <p className="panel-muted">
        {TREASURY_TEXT.topUpEnough} {formatUsdCents(plan.refillBelowUsdCents)}.
      </p>
    );
  }
  return (
    <>
      <p>
        <span className="panel-status panel-status--warn">
          {TREASURY_TEXT.topUpTitle}: {TREASURY_TEXT.topUpNeeded} {formatUsdCents(plan.targetUsdCents)}
        </span>
      </p>
      <dl className="panel-dl">
        <dt>{TREASURY_TEXT.topUpCredit}</dt>
        <dd>{formatUsdCents(plan.creditUsdCents)}</dd>
        <dt>
          {TREASURY_TEXT.topUpSend} {plan.feePercent}%
        </dt>
        <dd>{formatUsdCents(plan.sendUsdCents)}</dd>
        <dt>
          {TREASURY_TEXT.topUpRub} {plan.usdtRubRate}
        </dt>
        <dd>{formatKopecks(plan.rubKopecks)}</dd>
      </dl>
      <p className="panel-muted">{TREASURY_TEXT.topUpNote}</p>
    </>
  );
}

/** Кошелёк FKWallet: рубли крупно, USDT и прочее — если на них что-то есть. */
function FkWalletCard({ reading }: { reading: TreasuryReport['fkwallet'] }) {
  return (
    <section className="panel-card">
      <h2 className="panel-title">{TREASURY_TEXT.fkwalletTitle}</h2>
      {reading.state === 'ok' || reading.state === 'stale' ? (
        <>
          {reading.data.balances
            .filter((row) => row.currency === 'RUB' || Number(row.raw) > 0)
            .map((row) => (
              <p key={row.currency}>
                {row.currency === 'RUB' && row.amountKopecks !== null ? (
                  <span className="panel-status panel-status--ok panel-status--lg">
                    {formatKopecks(row.amountKopecks)}
                  </span>
                ) : (
                  <span className="panel-status panel-status--muted panel-status--lg">
                    {row.raw} {row.currency}
                  </span>
                )}{' '}
                <span className="panel-muted">{TREASURY_TEXT.balance}</span>
              </p>
            ))}
          <ReadingNote reading={reading} />
        </>
      ) : (
        <ProviderFallback reading={reading} />
      )}
    </section>
  );
}

/** Касса Freekassa: рубли крупно, остальные валюты — если на них что-то есть. */
function FreekassaCard({ reading }: { reading: TreasuryReport['freekassa'] }) {
  return (
    <section className="panel-card">
      <h2 className="panel-title">{TREASURY_TEXT.freekassaTitle}</h2>
      {reading.state === 'ok' || reading.state === 'stale' ? (
        <>
          {reading.data.balances
            .filter((row) => row.currency === 'RUB' || Number(row.raw) > 0)
            .map((row) => (
              <p key={row.currency}>
                {row.currency === 'RUB' && row.amountKopecks !== null ? (
                  <span className="panel-status panel-status--ok panel-status--lg">
                    {formatKopecks(row.amountKopecks)}
                  </span>
                ) : (
                  <span className="panel-status panel-status--muted panel-status--lg">
                    {row.raw} {row.currency}
                  </span>
                )}{' '}
                <span className="panel-muted">{TREASURY_TEXT.balance}</span>
              </p>
            ))}
          <ReadingNote reading={reading} />
        </>
      ) : (
        <ProviderFallback reading={reading} />
      )}
    </section>
  );
}

/** Последние выводы с кассы: куда ушли и чем закончились. */
function WithdrawalsTable({ reading }: { reading: TreasuryReport['freekassa'] }) {
  if (reading.state !== 'ok' && reading.state !== 'stale') return null;
  const rows = reading.data.withdrawals;
  return (
    <section>
      <h2 className="panel-title">{TREASURY_TEXT.withdrawalsTitle}</h2>
      {rows.length === 0 ? (
        <p className="panel-empty">{TREASURY_TEXT.noWithdrawals}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{TREASURY_TEXT.date}</th>
                <th className="panel-num">{TREASURY_TEXT.amount}</th>
                <th>{TREASURY_TEXT.method}</th>
                <th>{TREASURY_TEXT.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.date ?? CELL_TEXT.noData}</td>
                  <td className="panel-num">{withdrawalAmount(row)}</td>
                  <td>{row.methodName ?? `${TREASURY_TEXT.unknownMethod} ${row.methodId}`}</td>
                  <td>{withdrawalStatus(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel-muted">{TREASURY_TEXT.withdrawalTimeNote}</p>
        </div>
      )}
    </section>
  );
}

function withdrawalAmount(row: FreekassaWithdrawalRow): string {
  return row.amountKopecks !== null ? formatKopecks(row.amountKopecks) : `${row.raw} ${row.currency}`;
}

/** Код вне справочника показывается числом: подписать наугад — соврать. */
function withdrawalStatus(status: number): string {
  const known = (TREASURY_TEXT.withdrawalStatus as Readonly<Record<number, string>>)[status];
  return known ?? `${TREASURY_TEXT.status} ${status}`;
}

/** Когда цифры получены; при отказе провайдера — что показано прежнее число. */
function ReadingNote({ reading }: { reading: ProviderReading<unknown> }) {
  if (reading.state === 'stale') {
    return (
      <p>
        <span className="panel-status panel-status--warn">
          {TREASURY_TEXT.staleFrom} <LocalTime iso={reading.readAt.toISOString()} />,{' '}
          {TREASURY_TEXT.staleSuffix}
        </span>
      </p>
    );
  }
  if (reading.state === 'ok') {
    return (
      <p className="panel-muted">
        {TREASURY_TEXT.receivedAt} <LocalTime iso={reading.readAt.toISOString()} />
      </p>
    );
  }
  return null;
}

function ProviderFallback({ reading }: { reading: ProviderReading<unknown> }) {
  return (
    <p className="panel-muted">
      {reading.state === 'not_configured' ? TREASURY_TEXT.notConfigured : TREASURY_TEXT.unavailable}
    </p>
  );
}
