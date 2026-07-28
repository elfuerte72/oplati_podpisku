import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentTerminal,
  deleteExpiredLinkTokens,
  findExpiredPayableOrders,
  findPendingPaymentByOrderId,
  getDb,
  getServiceById,
  getUserTelegramId,
  transitionOrder,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getBot } from '../telegram/bot.ts';
import { buildOrderExpiredMessage } from '../telegram/templates.ts';

/**
 * Cron `expire-payments` — каждые 15 минут. Находит заказы в pending_payment
 * с истёкшим `expires_at` → переводит в `expired` и отправляет пользователю
 * сообщение «срок оплаты истёк».
 */

const log = childLogger('cron.expire-payments');

export async function expirePayments(): Promise<{ expired: number; errors: number }> {
  log.info({ event: 'cron.expire_payments.start' });

  const db = getDb();
  const expired = await findExpiredPayableOrders(db);

  log.info({ event: 'cron.expire_payments.found', count: expired.length });

  let errors = 0;

  for (const order of expired) {
    try {
      // ПОРЯДОК ВАЖЕН (аудит 2026-07-28): сначала клеймим платёж, потом хороним
      // заказ. Раньше было наоборот, и вебхук, пришедший между двумя запросами,
      // давал неисправимое состояние: `claimPaymentSucceeded` побеждал (платёж
      // ещё pending), а следом `transitionOrder(paid)` из уже `expired` был
      // запрещён — деньги приняты, заказ мёртв, recovery не видит его ни как
      // `paid`, ни как `pending`.
      //
      // Claim работает замком: он атомарно переводит pending → failed. Не
      // получилось (null) — значит платёж уже забрал кто-то другой (вебхук или
      // poll), оплата в процессе, и хоронить заказ НЕЛЬЗЯ: победитель сам
      // переведёт его в `paid`. Пропускаем — следующий прогон разберётся.
      const pendingPayment = await findPendingPaymentByOrderId(db, order.id);
      if (pendingPayment) {
        const claimed = await claimPaymentTerminal(db, pendingPayment.id, log);
        if (!claimed) {
          log.info({
            event: 'cron.expire_payments.payment_claimed_elsewhere',
            orderId: order.id,
            paymentId: pendingPayment.id,
          });
          continue;
        }
      }

      // Платёж заклеймён (или его не было — протухший черновик). Теперь заказ
      // можно хоронить: поздняя оплата по failed-платежу пойдёт по ветке
      // `paid_after_terminal` с алёртом и DM владельцу.
      await transitionOrder(db, {
        orderId: order.id,
        toStatus: 'expired',
        actorType: 'system',
        eventType: 'order_expired',
        payload: { shortId: order.shortId },
      });

      const telegramId = await getUserTelegramId(db, order.userId);
      if (telegramId) {
        // Название сервиса — best-effort: сбой lookup'а не должен лишить
        // клиента уведомления (шаблон умеет в фоллбек «заказ»).
        let serviceLabel: string | null = order.customServiceDescription ?? null;
        if (order.serviceId) {
          try {
            serviceLabel = (await getServiceById(db, order.serviceId))?.name ?? serviceLabel;
          } catch (err) {
            log.warn({ event: 'cron.expire_payments.service_lookup_failed', orderId: order.id, err });
          }
        }
        try {
          // telegramId — СТРОКА (не Number): большие 64-битные chat_id теряют
          // точность в double, уведомление ушло бы не тому получателю (L4).
          await getBot().api.sendMessage(
            telegramId,
            buildOrderExpiredMessage({
              serviceLabel,
              amountKopecks: order.amountRub,
              createdAt: order.createdAt,
            }),
          );
        } catch (err) {
          log.warn({ event: 'cron.expire_payments.notify_failed', orderId: order.id, err });
        }
      }
    } catch (err) {
      errors++;
      log.error({ event: 'cron.expire_payments.error', orderId: order.id, err });
      Sentry.captureException(err, {
        tags: { source: 'cron.expire-payments' },
        extra: { orderId: order.id },
      });
    }
  }

  // Попутная чистка давно протухших неиспользованных link_tokens (аудит F-17):
  // отдельный cron не заводим — токены и заказы протухают по одной природе.
  // Best-effort: сбой чистки не влияет на результат основного джоба.
  try {
    await deleteExpiredLinkTokens(db, {}, log);
  } catch (err) {
    log.warn({ event: 'cron.expire_payments.link_tokens_cleanup_failed', err });
  }

  log.info({ event: 'cron.expire_payments.done', expired: expired.length, errors });
  return { expired: expired.length, errors };
}
