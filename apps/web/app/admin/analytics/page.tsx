import type { Metadata } from 'next';
import Link from 'next/link';

import {
  activeSubjectsByDay,
  catalogClicksByService,
  funnelByPeriod,
  getDb,
  revenueByDay,
  revenueSummary,
  stepConversions,
  topServicesByPaidOrders,
} from '@oplati/db';

import { BarsByDay } from '@/components/panel/charts/BarsByDay';
import { HBars } from '@/components/panel/charts/HBars';
import { LineByDay } from '@/components/panel/charts/LineByDay';
import { PanelHelp } from '@/components/panel/PanelHelp';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import {
  ANALYTICS_PERIODS,
  parsePeriod,
  periodBounds,
  periodHref,
  type AnalyticsPeriod,
} from '@/lib/panel/analytics/period';
import { formatCount, formatKopecks, formatShare } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  ANALYTICS_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  HELP_TEXT,
  PAGE_HINT,
  PERIOD_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/analytics` — «как идут дела» за 7/30/90 дней (панель v2, ветка A).
 *
 * Три блока — деньги, воронка, продукт — из выборок `packages/db`
 * (`analytics-panel.ts`); своих SQL здесь нет. Графики — серверный SVG без
 * клиентского JS. Живое обновление выключено: запросы тяжелее списков, а
 * данные не меняются посекундно.
 *
 * Деньги приходят копейками и переводятся в рубли только здесь, форматтером
 * панели (инвариант 3).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.analytics };

const PATH = '/admin/analytics';

export default async function PanelAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('analytics');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current={PATH} live={false}>
        <PanelForbidden title={SECTION_TITLES.analytics} />
      </PanelShell>
    );
  }

  const period = parsePeriod(await searchParams);
  const bounds = periodBounds(period, new Date());
  const range = { since: bounds.since.toISOString(), until: bounds.until.toISOString() };
  const db = getDb();

  const [revenue, summary, funnel, topServices, clicks, activity] = await Promise.all([
    revenueByDay(db, range),
    revenueSummary(db, range),
    funnelByPeriod(db, range),
    topServicesByPaidOrders(db, range),
    catalogClicksByService(db, range),
    activeSubjectsByDay(db, range),
  ]);

  const funnelRows = stepConversions(funnel);
  const hasMoney = summary.amountKopecks > 0 || summary.paidOrders > 0;
  const hasFunnel = funnelRows.some((r) => r.subjects > 0);
  const hasActivity = activity.some((p) => p.subjects > 0);

  return (
    <PanelShell actor={access.actor} current={PATH} live={false}>
      <PanelPageHeader
        title={SECTION_TITLES.analytics}
        aside={<PeriodSwitch current={period} />}
      >
        <p className="panel-muted">{PAGE_HINT.analytics}</p>
      </PanelPageHeader>

      <PanelHelp
        title={HELP_TEXT.analytics.title}
        hint={HELP_TEXT.analytics.hint}
        cards={HELP_TEXT.analytics.cards}
      />

      <div className="panel-grid" style={{ gridTemplateColumns: '1fr' }}>
        {/* ── Деньги ── */}
        <section className="panel-card">
          <h2 className="panel-title">{ANALYTICS_TEXT.money}</h2>
          <div className="panel-stats">
            <Stat label={ANALYTICS_TEXT.revenue} value={formatKopecks(summary.amountKopecks)} />
            <Stat label={ANALYTICS_TEXT.paidOrders} value={formatCount(summary.paidOrders)} />
            <Stat label={ANALYTICS_TEXT.averageCheck} value={formatKopecks(summary.averageKopecks)} />
          </div>
          {hasMoney ? (
            <>
              <BarsByDay
                title={ANALYTICS_TEXT.revenueByDay}
                points={revenue.map((p) => ({ day: p.day, value: p.amountKopecks }))}
                format={formatKopecks}
              />
              <LineByDay
                title={ANALYTICS_TEXT.paidOrdersByDay}
                points={revenue.map((p) => ({ day: p.day, value: p.paidOrders }))}
                format={formatCount}
              />
            </>
          ) : (
            <p className="panel-empty">{EMPTY_TEXT.analytics}</p>
          )}
        </section>

        {/* ── Воронка ── */}
        <section className="panel-card">
          <h2 className="panel-title">{ANALYTICS_TEXT.funnel}</h2>
          <p className="panel-muted">{ANALYTICS_TEXT.funnelHint}</p>
          {hasFunnel ? (
            <HBars
              title={ANALYTICS_TEXT.funnel}
              rows={funnelRows.map((r) => ({
                key: r.name,
                label: `${r.step}. ${r.title}`,
                value: r.subjects,
                valueText: formatCount(r.subjects),
                note: r.conversion === null ? null : formatShare(r.conversion),
              }))}
            />
          ) : (
            <p className="panel-empty">{EMPTY_TEXT.analytics}</p>
          )}
        </section>

        {/* ── Продукт ── */}
        <section className="panel-card">
          <h2 className="panel-title">{ANALYTICS_TEXT.product}</h2>

          <h3 className="panel-muted" style={{ marginTop: 12 }}>
            {ANALYTICS_TEXT.topServices}
          </h3>
          {topServices.length > 0 ? (
            <div className="panel-table-scroll">
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>{COLUMN_TITLES.service}</th>
                    <th className="panel-num">{COLUMN_TITLES.ordersCount}</th>
                    <th className="panel-num">{COLUMN_TITLES.amount}</th>
                  </tr>
                </thead>
                <tbody>
                  {topServices.map((row) => (
                    <tr key={row.serviceSlug ?? '__custom'}>
                      <td>
                        {row.serviceSlug === null
                          ? ANALYTICS_TEXT.outsideCatalog
                          : (row.title ?? row.serviceSlug)}
                      </td>
                      <td className="panel-num">{formatCount(row.orders)}</td>
                      <td className="panel-num">{formatKopecks(row.amountKopecks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="panel-empty">{EMPTY_TEXT.analytics}</p>
          )}

          <h3 className="panel-muted" style={{ marginTop: 16 }}>
            {ANALYTICS_TEXT.catalogClicks}
          </h3>
          {clicks.length > 0 ? (
            <HBars
              title={ANALYTICS_TEXT.catalogClicks}
              rows={clicks.map((row) => ({
                key: row.serviceSlug,
                // Слаг, которого в каталоге уже нет, показываем как есть с
                // пометкой: история кликов старше каталога.
                label: row.title ?? `${row.serviceSlug} · ${ANALYTICS_TEXT.archivedService}`,
                value: row.clicks,
                valueText: `${formatCount(row.clicks)} · ${formatCount(row.subjects)} ${ANALYTICS_TEXT.people}`,
              }))}
            />
          ) : (
            <p className="panel-empty">{EMPTY_TEXT.analytics}</p>
          )}

          <h3 className="panel-muted" style={{ marginTop: 16 }}>
            {ANALYTICS_TEXT.activity}
          </h3>
          <p className="panel-muted">{ANALYTICS_TEXT.activityHint}</p>
          {hasActivity ? (
            <LineByDay
              title={ANALYTICS_TEXT.activity}
              points={activity.map((p) => ({ day: p.day, value: p.subjects }))}
              format={formatCount}
            />
          ) : (
            <p className="panel-empty">{EMPTY_TEXT.analytics}</p>
          )}
        </section>
      </div>
    </PanelShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-stat">
      <div className="panel-stat__label">{label}</div>
      <div className="panel-stat__value">{value}</div>
    </div>
  );
}

/** Переключатель периода — три ссылки, без клиентского JS; текущий выделен. */
function PeriodSwitch({ current }: { current: AnalyticsPeriod }) {
  return (
    <nav className="panel-period" aria-label={ANALYTICS_TEXT.period}>
      {ANALYTICS_PERIODS.map((p) => (
        <Link key={p} href={periodHref(PATH, p)} aria-current={p === current ? 'page' : undefined}>
          {PERIOD_TITLES[p]}
        </Link>
      ))}
    </nav>
  );
}
