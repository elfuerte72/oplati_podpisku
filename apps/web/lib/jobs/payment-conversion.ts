import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { countInvoiceConversion, getDb } from '@oplati/db';

import { notifyOps } from '../alerts/notify-ops.ts';
import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';

/**
 * Наблюдение за конверсией «счёт выставлен → оплачен».
 *
 * Закрывает слепое пятно, из-за которого о неработающих оплатах Love&Pay
 * узнали от клиентов: классификатор `isPaymentGatewayUnavailable` реагирует
 * только на транспорт (таймаут, 5xx, лежащий прокси), а самый частый реальный
 * отказ — «шлюз отвечает 200, ссылку выдаёт, а платежи у клиентов не проходят» —
 * для кода выглядит полным успехом. Единственный его симптом — счета
 * выставляются, а оплат нет.
 *
 * Зовётся из cron `poll-payment` (каждые 5 минут) — отдельная запись в crontab
 * не нужна, а значит нечему разъехаться с тем, что реально стоит на VPS.
 *
 * Это мониторинг: свои ошибки ловим внутри, наружу не бросаем (паттерн
 * `proxy-health` / `vcc-balance`) — сбой метрики не должен ронять добор платежей.
 */

const log = childLogger('payment-conversion');

/** Окно наблюдения и отсрочка «дать счёту шанс быть оплаченным». */
const WINDOW_MINUTES = 70;
const GRACE_MINUTES = 10;

/**
 * Минимум выставленных счетов, ниже которого молчим.
 *
 * При нашем потоке (~50 заказов в сутки) ноль оплат за час — обычное дело
 * ночью. Без этого порога алёрт превратился бы в шум, а шумный алёрт не
 * читают — и он не сработает, когда действительно понадобится.
 */
const MIN_SAMPLE = 5;

// Дедуп DM: пока шлюз не проводит платежи, cron считает конверсию каждые 5
// минут. Sentry группирует сам, личку — нет.
const OPS_DM_DEDUP_MS = 60 * 60 * 1000;
let lastOpsDmAt = 0;

/** Только для unit-тестов — сбрасывает окно дедупа DM. */
export function resetConversionAlertDedupForTests(): void {
  lastOpsDmAt = 0;
}

export async function alertOnZeroPaymentConversion(): Promise<void> {
  try {
    const { invoiced, paid } = await countInvoiceConversion(getDb(), {
      windowMinutes: WINDOW_MINUTES,
      graceMinutes: GRACE_MINUTES,
    });

    log.info({ event: 'payment_conversion.measured', invoiced, paid });

    if (invoiced < MIN_SAMPLE || paid > 0) return;

    const gateway = serverEnv.PAYMENT_PRIMARY_PROVIDER;
    log.error({ event: 'payment_conversion.zero', invoiced, gateway });
    Sentry.captureMessage('Счета выставляются, оплат нет — шлюз, вероятно, не проводит платежи', {
      level: 'error',
      tags: { source: 'payment-conversion', alert: 'zero_conversion' },
      extra: { invoiced, windowMinutes: WINDOW_MINUTES, gateway },
    });

    const now = Date.now();
    if (now - lastOpsDmAt < OPS_DM_DEDUP_MS) return;
    lastOpsDmAt = now;
    await notifyOps(
      `Похоже, оплаты не проходят: за последний час выставлено ${invoiced} счетов через ${gateway}, оплачено 0. ` +
        `Проверь шлюз и при необходимости переключи PAYMENT_PRIMARY_PROVIDER на резервный + redeploy.`,
      { stream: 'critical' },
    );
  } catch (err) {
    // Мониторинг не должен ронять cron: логируем и уходим.
    log.error({ event: 'payment_conversion.failed', err });
    Sentry.captureException(err, { tags: { source: 'payment-conversion' } });
  }
}
