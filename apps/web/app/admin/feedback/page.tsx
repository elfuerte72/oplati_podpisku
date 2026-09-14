import type { Metadata } from 'next';
import Link from 'next/link';

import {
  PANEL_DEFAULT_ROWS,
  feedbackSummaryForPanel,
  getDb,
  listClientFeedbackForPanel,
} from '@oplati/db';

import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPager } from '@/components/panel/PanelPager';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import {
  ANALYTICS_PERIODS,
  parsePeriod,
  periodBounds,
  periodHref,
  type AnalyticsPeriod,
} from '@/lib/panel/analytics/period';
import { feedbackAnswerText, isLowRating } from '@/lib/panel/feedback-text';
import { formatCount, formatShare } from '@/lib/panel/format';
import { panelPageAccess } from '@/lib/panel/guard';
import { parsePanelPage } from '@/lib/panel/paging';
import {
  ANALYTICS_TEXT,
  CELL_TEXT,
  COLUMN_TITLES,
  EMPTY_TEXT,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_TEXT,
  PAGE_HINT,
  PERIOD_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/feedback` — лента ответов на опросы и оценок (панель v2, ветка D).
 * Единица — ОТВЕТ клиента; состояния «просмотрено» нет намеренно (это схема
 * ради счётчика), счётчик в меню — ответы за последние 24 ч.
 *
 * Период и страница — в адресе (`?period=7|30|90&page=N`), как у остальных
 * списков. Живое обновление включено: записи создаёт бот, лента может
 * обновляться под рукой.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.feedback };

const PATH = '/admin/feedback';

function href(period: AnalyticsPeriod, page: number): string {
  return page > 1 ? `${periodHref(PATH, period)}&page=${page}` : periodHref(PATH, period);
}

export default async function PanelFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await panelPageAccess('feedback');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current={PATH} live={false}>
        <PanelForbidden title={SECTION_TITLES.feedback} />
      </PanelShell>
    );
  }

  const params = await searchParams;
  const period = parsePeriod(params);
  const page = parsePanelPage(params.page);
  const bounds = periodBounds(period, new Date());
  const since = bounds.since.toISOString();
  const db = getDb();

  const [summary, feed] = await Promise.all([
    feedbackSummaryForPanel(db, { since }),
    listClientFeedbackForPanel(db, {
      since,
      limit: PANEL_DEFAULT_ROWS,
      offset: (page - 1) * PANEL_DEFAULT_ROWS,
    }),
  ]);

  return (
    <PanelShell actor={access.actor} current={PATH}>
      <PanelPageHeader
        title={SECTION_TITLES.feedback}
        aside={
          <nav className="panel-period" aria-label={ANALYTICS_TEXT.period}>
            {ANALYTICS_PERIODS.map((p) => (
              <Link key={p} href={href(p, 1)} aria-current={p === period ? 'page' : undefined}>
                {PERIOD_TITLES[p]}
              </Link>
            ))}
          </nav>
        }
      >
        <p className="panel-muted">{PAGE_HINT.feedback}</p>
      </PanelPageHeader>

      <section className="panel-card" style={{ marginBottom: 16 }}>
        <h2 className="panel-title">{FEEDBACK_TEXT.summary}</h2>
        <p className="panel-muted">{FEEDBACK_TEXT.shareHint}</p>
        <div className="panel-table-scroll">
          <table className="panel-table">
            <thead>
              <tr>
                <th>{FEEDBACK_TEXT.kind}</th>
                <th className="panel-num">{FEEDBACK_TEXT.sent}</th>
                <th className="panel-num">{FEEDBACK_TEXT.answered}</th>
                <th className="panel-num">{FEEDBACK_TEXT.share}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.kind}>
                  <td>{FEEDBACK_KIND_LABELS[row.kind]}</td>
                  <td className="panel-num">{formatCount(row.sent)}</td>
                  <td className="panel-num">{formatCount(row.answered)}</td>
                  {/* Доля считается здесь: `null` при нуле касаний — делить нечем. */}
                  <td className="panel-num">
                    {formatShare(row.sent > 0 ? row.answered / row.sent : null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {feed.items.length === 0 ? (
        <p className="panel-empty">{page > 1 ? EMPTY_TEXT.beyondLastPage : EMPTY_TEXT.feedback}</p>
      ) : (
        <div className="panel-table-scroll">
          <table className="panel-table panel-table--cards">
            <thead>
              <tr>
                <th>{FEEDBACK_TEXT.when}</th>
                <th>{FEEDBACK_TEXT.kind}</th>
                <th>{FEEDBACK_TEXT.answer}</th>
                <th>{COLUMN_TITLES.client}</th>
                <th>{COLUMN_TITLES.order}</th>
              </tr>
            </thead>
            <tbody>
              {feed.items.map((row) => {
                const low = isLowRating(row);
                return (
                  <tr key={row.id}>
                    <td data-label={FEEDBACK_TEXT.when}>
                      <LocalTime iso={row.createdAt.toISOString()} />
                    </td>
                    <td data-label={FEEDBACK_TEXT.kind}>{FEEDBACK_KIND_LABELS[row.kind]}</td>
                    <td data-label={FEEDBACK_TEXT.answer}>
                      <span className={`panel-status ${low ? 'panel-status--danger' : 'panel-status--muted'}`}>
                        {feedbackAnswerText(row)}
                      </span>
                    </td>
                    <td data-label={COLUMN_TITLES.client}>
                      <Link href={`/admin/clients/${row.client.id}`}>
                        {row.client.displayName ?? row.client.telegramId ?? CELL_TEXT.noName}
                      </Link>
                    </td>
                    <td data-label={COLUMN_TITLES.order}>
                      {row.order ? (
                        <>
                          <Link href={`/admin/orders/${row.order.shortId}`}>{row.order.shortId}</Link>
                          {row.order.serviceName ? (
                            <span className="panel-muted"> · {row.order.serviceName}</span>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Та же разметка, что у остальных списков: третьего вида листания в
          панели не осталось. */}
      <PanelPager page={page} hasMore={feed.hasMore} hrefFor={(next) => href(period, next)} />
    </PanelShell>
  );
}
