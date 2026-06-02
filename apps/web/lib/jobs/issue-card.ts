import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  createCard,
  findActiveByUserId,
  findRecyclableCard,
  getDb,
  getOrderById,
  getUserTelegramId,
  markActive,
  setOrderCardId,
  transitionOrder,
  updateBalance,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getPaySpaceClient } from '../pay-space/index.ts';
import { getBot } from '../telegram/bot.ts';

/**
 * Job `issue-card` — выпускает (или переиспользует) виртуальную USD-карту
 * после успешной оплаты заказа.
 *
 * Алгоритм:
 *   1. Загрузить order; status должен быть `paid`. Иначе abort.
 *   2. Найти активную карту пользователя (findActiveByUserId) → если есть,
 *      пополняем её топ-ап'ом.
 *   3. Если нет — поискать recycled-карту (findRecyclableCard) → если есть,
 *      переписать userId на текущего пользователя, активировать, пополнить.
 *   4. Если нет — createCard в paypace + сохранить в БД.
 *   5. Привязать карту к order (setOrderCardId).
 *   6. transitionOrder paid → in_fulfillment → completed (две транзакции).
 *   7. Отправить пользователю в TG карточку с маскированным PAN + срок + CVC.
 *
 * На любой фейл → transitionOrder paid → failed + Sentry critical + сообщение
 * пользователю.
 *
 * Этот код вызывается:
 *   - sync-fallback из webhook (см. `lib/loveandpay/handlers.ts` → dispatcher).
 *   - либо async через Trigger.dev (пока не подключён — план MVP, Task 6.1).
 */

const log = childLogger('job.issue-card');

export async function issueCard(orderId: string): Promise<void> {
  log.info({ event: 'job.issue_card.start', orderId });

  const db = getDb();
  const order = await getOrderById(db, orderId);
  if (!order) {
    log.error({ event: 'job.issue_card.order_not_found', orderId });
    Sentry.captureMessage('issue-card: order not found', {
      level: 'error',
      tags: { source: 'job.issue-card' },
      extra: { orderId },
    });
    return;
  }
  if (order.status !== 'paid') {
    log.warn({ event: 'job.issue_card.invalid_status', orderId, status: order.status });
    return;
  }
  if (!order.originalAmount || order.originalAmount <= 0) {
    log.error({ event: 'job.issue_card.invalid_amount', orderId });
    await markOrderFailed(orderId, 'invalid_amount');
    return;
  }

  const amountUsdCents = order.originalAmount;

  try {
    const paypace = getPaySpaceClient();

    // 1. Активная карта пользователя — топ-ап.
    let card = await findActiveByUserId(db, order.userId);
    if (card) {
      log.info({ event: 'job.issue_card.reusing_active', orderId, cardId: card.id });
      const topup = await paypace.topupCard({
        cardId: card.providerCardId,
        amountUsdCents,
      });
      await updateBalance(db, card.id, amountUsdCents, log);
      log.info({
        event: 'job.issue_card.topup_ok',
        cardId: card.id,
        balanceUsdCents: topup.balanceUsdCents,
      });
    } else {
      // 2. Recyclable.
      const recyclable = await findRecyclableCard(db, log);
      if (recyclable) {
        log.info({ event: 'job.issue_card.reusing_recyclable', orderId, cardId: recyclable.id });
        await paypace.topupCard({
          cardId: recyclable.providerCardId,
          amountUsdCents,
        });
        await markActive(db, recyclable.id, order.userId, log);
        await updateBalance(db, recyclable.id, amountUsdCents, log);
        card = recyclable;
      } else {
        // 3. Создаём новую.
        const created = await paypace.createCard({
          externalUserId: order.userId,
          initialBalanceUsdCents: amountUsdCents,
        });
        card = await createCard(
          db,
          {
            userId: order.userId,
            providerCardId: created.cardId,
            panMasked: created.panMasked,
            balanceUsdCents: created.balanceUsdCents,
          },
          log,
        );
        log.info({
          event: 'job.issue_card.created',
          orderId,
          cardId: card.id,
          panMasked: card.panMasked, // panMasked можно — это маска
        });

        // Полные реквизиты надо передать пользователю — НЕ логируем сюда `pan`/`cvc`.
        await sendCardCredentialsToUser({
          telegramId: await resolveTelegramIdByUserId(order.userId),
          panMasked: created.panMasked,
          fullPan: created.pan,
          expMonth: created.expMonth,
          expYear: created.expYear,
          cvc: created.cvc,
          serviceShortId: order.shortId,
        });
      }
    }

    // 4. Привязать card к order.
    if (card) {
      await setOrderCardId(db, orderId, card.id, log);
    }

    // 5. Переход paid → in_fulfillment → completed.
    await transitionOrder(db, {
      orderId,
      toStatus: 'in_fulfillment',
      actorType: 'system',
      eventType: 'card_assigned',
      payload: card ? { cardId: card.id, panMasked: card.panMasked } : null,
    });
    await transitionOrder(db, {
      orderId,
      toStatus: 'completed',
      actorType: 'system',
      eventType: 'fulfillment_completed',
      payload: card ? { cardId: card.id } : null,
    });

    log.info({ event: 'job.issue_card.completed', orderId });
  } catch (err) {
    log.error({ event: 'job.issue_card.failed', orderId, err });
    Sentry.captureException(err, {
      level: 'error',
      tags: { source: 'job.issue-card' },
      extra: { orderId },
    });
    await markOrderFailed(orderId, 'paypace_error');
  }
}

async function markOrderFailed(orderId: string, reason: string): Promise<void> {
  try {
    const db = getDb();
    await transitionOrder(db, {
      orderId,
      toStatus: 'failed',
      actorType: 'system',
      eventType: 'fulfillment_failed',
      payload: { reason },
    });
  } catch (err) {
    log.error({ event: 'job.issue_card.mark_failed_error', orderId, err });
    Sentry.captureException(err, {
      level: 'error',
      tags: { source: 'job.issue-card', step: 'mark_failed' },
    });
  }
}

type SendCredentialsArgs = {
  telegramId: string | null;
  panMasked: string;
  fullPan: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  serviceShortId: string;
};

/**
 * Отправка реквизитов карты пользователю в Telegram.
 * Полный PAN и CVC передаются ТОЛЬКО здесь — никаких log.info с этими полями.
 */
async function sendCardCredentialsToUser(args: SendCredentialsArgs): Promise<void> {
  if (!args.telegramId) {
    log.warn({ event: 'job.issue_card.send_credentials.no_telegram', shortId: args.serviceShortId });
    return;
  }

  const exp = `${String(args.expMonth).padStart(2, '0')}/${String(args.expYear).slice(-2)}`;
  const message = [
    `Заказ ${args.serviceShortId} оплачен. Реквизиты виртуальной карты:`,
    '',
    `Номер: ${args.fullPan}`,
    `Срок: ${exp}`,
    `CVC: ${args.cvc}`,
    '',
    'Введите эти данные при оплате в нужном сервисе. Если потребуется адрес — используйте любой американский (например ZIP 10001).',
    '',
    'После активации сервиса напишите сюда — я уточню, всё ли получилось.',
  ].join('\n');

  try {
    await getBot().api.sendMessage(Number(args.telegramId), message);
    log.info({
      event: 'job.issue_card.credentials_sent',
      shortId: args.serviceShortId,
      panMasked: args.panMasked,
    });
  } catch (err) {
    log.error({ event: 'job.issue_card.send_credentials.failed', shortId: args.serviceShortId, err });
    Sentry.captureException(err, {
      tags: { source: 'job.issue-card', step: 'send_credentials' },
    });
  }
}

async function resolveTelegramIdByUserId(userId: string): Promise<string | null> {
  try {
    return await getUserTelegramId(getDb(), userId);
  } catch (err) {
    log.error({ event: 'job.issue_card.resolve_telegram.failed', userId, err });
    return null;
  }
}
