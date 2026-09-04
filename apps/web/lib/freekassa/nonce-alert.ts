import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { DedupWindow } from '../alerts/dedup-window.ts';
import { notifyOps } from '../alerts/notify-ops.ts';
import { childLogger } from '../logger.ts';
import { isFreekassaNonceRejected } from './errors.ts';

/**
 * Прямой DM владельцу, когда Freekassa начала отвергать наши запросы по `nonce`
 * (инцидент 2026-08-15, `docs/incidents.md`).
 *
 * Почему отдельный канал, а не «Sentry разберётся»: у этого сбоя нет фазы
 * деградации. Счётчик nonce у провайдера — общий водяной знак кассы, и стоит
 * ему обогнать наш, как падает КАЖДОЕ обращение, включая `createOrder`: клиент,
 * нажавший «Оплатить», счёта не получает вовсе. При этом снаружи всё зелёное —
 * прод жив, `/api/health` и `/api/ready` в порядке, вебхуки работают, — а
 * лечение ручное (`setval` последовательности выше значения провайдера).
 * В инциденте между первым отказом и разбором прошло почти два часа именно
 * потому, что об этом никто не узнавал напрямую.
 *
 * Алёрт НИЧЕГО не чинит и осознанно не пытается: автоподъём счётчика — это
 * запись в денежный путь вслепую, решение владельца о ней отдельное
 * (`docs/BACKLOG.md`).
 */

const log = childLogger('freekassa.nonce-alert');

// Пока счётчик не поднят, отказ повторяется на каждом обращении (в инциденте —
// каждые 5 минут кроном). Sentry группирует сам, а личку заспамили бы: best-effort
// дедуп на warm-инстансе, как в proxy-health/gateway. Холодный старт обнуляет
// окно — в худшем случае один лишний DM, это дешевле пропущенной аварии.
const OPS_DM_DEDUP_MS = 60 * 60 * 1000;
const dedup = new DedupWindow(OPS_DM_DEDUP_MS);

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetFreekassaNonceAlertDedupForTests(): void {
  dedup.resetForTests();
}

const DM_TEXT =
  'КРИТИЧНО: Freekassa отвергает наши запросы — "nonce already exist". ' +
  'Счета на оплату сейчас НЕ выставляются: клиент, нажавший "Оплатить", получает ошибку. ' +
  'Вероятная причина: счётчик nonce на стороне кассы обогнал наш (так было 2026-08-15). ' +
  'Сначала убедиться, что отказы идут ПОДРЯД: единичный бывает и от разъезда порядка ' +
  'запросов, тогда счётчик трогать не нужно. Если подряд — лечение ручное: измерить ' +
  'водяной знак провайдера и поднять последовательность freekassa_nonce в прод-БД выше ' +
  'него; порядок в docs/incidents.md, инцидент 2026-08-15.';

/**
 * Зовётся на каждом сбое обращения к Freekassa (наблюдатель `onApiError`
 * клиента) и сама решает, её ли это случай.
 *
 * **Never-throw буквально:** под `try` весь корпус, а не только доставка DM.
 * `Sentry.captureMessage` и pino — тоже код, и их бросок здесь означал бы
 * отклонённый промис на fire-and-forget пути, то есть падение процесса
 * (Node 24 роняет процесс на необработанном отклонении). Падать из-за
 * НАБЛЮДАТЕЛЯ в момент аварии приёма оплаты — худший из возможных исходов.
 */
export async function alertOnFreekassaNonceRejected(
  err: unknown,
  ctx: { path: string },
): Promise<void> {
  if (!isFreekassaNonceRejected(err)) return;

  try {
    log.error({ event: 'freekassa.nonce_rejected', path: ctx.path });
    Sentry.captureMessage('Freekassa отвергает запросы по nonce — приём оплаты стоит', {
      level: 'error',
      tags: { source: 'freekassa', alert: 'freekassa_nonce_rejected' },
      extra: { path: ctx.path },
    });

    // Дедуп только для лички: Sentry группирует сам, и глушить его здесь значит
    // потерять счётчик событий, по которому видно, идёт сбой или уже кончился.
    if (!dedup.shouldSend('freekassa_nonce')) return;

    await notifyOps(DM_TEXT, {
      stream: 'payments',
      title: 'Freekassa отвергает запросы (nonce)',
      action: { text: 'убедиться, что отказы идут подряд, затем поднять последовательность nonce по docs/incidents.md' },
    });
  } catch (alertErr) {
    // Без captureException — анти-петля, как в notify-ops.ts: провал алёрта
    // породил бы новый issue и новый алёрт.
    log.error({ event: 'freekassa.nonce_rejected.alert_failed', err: alertErr });
  }
}
