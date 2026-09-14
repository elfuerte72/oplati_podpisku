import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  countHoldsForPanel,
  countPendingOrdersForPanel,
  countUnansweredSupportRequests,
  dailyAudience,
  dailyOrderFlow,
  dailyPaidOrders,
  dailySupport,
  getDb,
  getVccBalanceSnapshot,
  revenueSummary,
  VCC_SNAPSHOT_PROVIDER,
  type AnalyticsRange,
} from '@oplati/db';

import { isOpsDeliveryConfigured, notifyStream } from '../alerts/streams.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { type DailyReportNow, formatDailyReport } from '../reports/daily-report.ts';

/**
 * Дневной отчёт в тему «Отчёты» ops-группы: кто заходил, кто оплатил, что
 * ждёт сейчас. Крон `daily-report` — раз в сутки в 18:00 по Москве за сутки
 * «вчера 18:00 — сегодня 18:00», `infra/crontab.example`.
 *
 * Цифры дня обязательны: не прочиталась выборка — отчёта нет, крон получает
 * 500 (полуправда «0 оплат» при упавшем запросе хуже тишины). Срез «сейчас»
 * — по пункту best-effort: он справочный и дублирует рабочий стол панели.
 *
 * Дедупа нет намеренно: крон зовёт раз в сутки, а ручная переотправка
 * (`?day=`) и есть желаемый повтор.
 */

const log = childLogger('job.daily-report');

export type DailyReportResult = {
  day: string;
  sent: boolean;
  paidOrders: number;
};

export async function runDailyReport(input: {
  day: string;
  range: AnalyticsRange;
  partial: boolean;
}): Promise<DailyReportResult> {
  const db = getDb();
  const { day, range, partial } = input;

  const [revenue, audience, flow, paid, support, now] = await Promise.all([
    revenueSummary(db, range),
    dailyAudience(db, range),
    dailyOrderFlow(db, range),
    dailyPaidOrders(db, range),
    dailySupport(db, range),
    readNow(),
  ]);

  const text = formatDailyReport(
    { day, partial, revenue, audience, flow, paid, support, now },
    serverEnv.PANEL_HOST,
  );
  const sent = await notifyStream('reports', text);

  if (sent) {
    log.info({ event: 'job.daily_report.sent', day, partial, paidOrders: revenue.paidOrders });
  } else if (isOpsDeliveryConfigured()) {
    // Доставка настроена, а сообщение не ушло. В Sentry — можно: отчёт не
    // алёрт, и петли «провал доставки → issue → алёрт в ту же тему» нет.
    log.error({ event: 'job.daily_report.not_delivered', day });
    Sentry.captureMessage('Дневной отчёт не доставлен в ops-группу', {
      level: 'warning',
      tags: { source: 'job.daily-report' },
      extra: { day },
    });
  } else {
    log.warn({ event: 'job.daily_report.delivery_not_configured', day });
  }

  return { day, sent, paidOrders: revenue.paidOrders };
}

/** Срез «что ждёт сейчас»: каждый пункт отдельно, сбой одного не гасит остальные. */
async function readNow(): Promise<DailyReportNow> {
  const db = getDb();
  const [pending, holds, unanswered, vcc] = await Promise.allSettled([
    countPendingOrdersForPanel(db),
    countHoldsForPanel(db),
    countUnansweredSupportRequests(db),
    getVccBalanceSnapshot(db, VCC_SNAPSHOT_PROVIDER),
  ]);

  const settled = <T>(result: PromiseSettledResult<T>, part: string): T | null => {
    if (result.status === 'fulfilled') return result.value;
    log.warn({ event: 'job.daily_report.now_part_failed', part, err: result.reason });
    return null;
  };

  const snapshot = settled(vcc, 'vcc');
  return {
    pending: settled(pending, 'pending'),
    holds: settled(holds, 'holds'),
    unansweredSupport: settled(unanswered, 'support'),
    vcc: snapshot ? { balanceUsdCents: snapshot.balanceUsdCents, readAt: snapshot.readAt } : null,
  };
}
