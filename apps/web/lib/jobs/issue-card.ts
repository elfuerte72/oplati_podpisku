import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  createCard,
  findActiveByUserId,
  getDb,
  getOrderById,
  getUserTelegramId,
  setOrderCardId,
  transitionOrder,
  transitionOrderDetailed,
  updateBalance,
} from '@oplati/db';

import { serverEnv } from '../env.server.ts';
import { childLogger } from '../logger.ts';
import { cardFundingUsdCents } from '../pay-space/format.ts';
import { getPaySpaceClient, isPaySpaceConfigured } from '../pay-space/index.ts';
import { getBot } from '../telegram/bot.ts';

/**
 * Job `issue-card` — выпускает (или переиспользует) виртуальную USD-карту
 * после успешной оплаты заказа.
 *
 * Алгоритм:
 *   1. Загрузить order; status должен быть `paid`. Иначе abort.
 *   2. **Атомарный claim** `paid → in_fulfillment` (transitionOrderDetailed):
 *      продолжает ТОЛЬКО вызов, который реально сделал переход. Гонка/повтор
 *      (webhook + recovery cron, double-dispatch) → второй вызов видит
 *      `transitioned=false` и выходит ДО топ-апа. Это «at-most-once»: без
 *      idempotency-ключа провайдера мы предпочитаем «не пополнить дважды»
 *      риску «пополнить дважды» (двойная трата денег недопустима).
 *   3. Найти активную карту пользователя (findActiveByUserId) → топ-ап;
 *      иначе recycled-карта; иначе createCard в paypace + сохранить в БД.
 *   4. Привязать карту к order (setOrderCardId).
 *   5. transitionOrder in_fulfillment → completed.
 *   6. Отправить пользователю в TG карточку с маскированным PAN + срок + CVC.
 *
 * На любой фейл после claim → transitionOrder in_fulfillment → failed + Sentry.
 * Редкий случай «claim сделан, но инстанс умер до топ-апа» оставляет заказ в
 * `in_fulfillment` без карты (без двойной траты) — добивает оператор; recovery
 * cron такие НЕ переотрабатывает (claim уже не вернёт transitioned).
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

  // Граница платёжной фазы: пока PaySpace не подключён, не валим успешно
  // оплаченный заказ в `failed` — оставляем в `paid`, оператор доведёт выпуск
  // вручную. `failed` здесь означал бы «оплата провалилась», что неверно.
  if (!isPaySpaceConfigured()) {
    log.warn({ event: 'job.issue_card.skipped_no_paypace', orderId });
    Sentry.captureMessage(
      'issue-card: PaySpace не настроен — заказ оставлен в paid для ручного fulfillment',
      {
        level: 'warning',
        tags: { source: 'job.issue-card' },
        extra: { orderId },
      },
    );
    return;
  }

  // Сумма фондирования карты = цена сервиса + буфер на VAT/FX/foreign-fee.
  // Цена клиента (`originalAmount`) при этом не меняется — буфер только на карте,
  // остаток вернётся на VCC-баланс при release. См. cardFundingUsdCents.
  const priceUsdCents = order.originalAmount;
  const bufferPercent = serverEnv.PAYSPACE_CARD_BUFFER_PERCENT;
  const amountUsdCents = cardFundingUsdCents(priceUsdCents, bufferPercent);
  log.info({ event: 'job.issue_card.card_funding', orderId, priceUsdCents, bufferPercent, amountUsdCents });

  // Атомарный claim paid → in_fulfillment. Только этот вызов продолжит к топ-апу;
  // параллельный/повторный (webhook + recovery cron, double-dispatch) увидит
  // transitioned=false и выйдет, не пополняя карту повторно.
  const claim = await transitionOrderDetailed(db, {
    orderId,
    toStatus: 'in_fulfillment',
    actorType: 'system',
    eventType: 'fulfillment_started',
  });
  if (!claim.transitioned) {
    log.info({ event: 'job.issue_card.already_claimed', orderId, status: claim.order.status });
    return;
  }

  try {
    const paypace = getPaySpaceClient();

    // 1. Активная карта пользователя — топ-ап.
    let card = await findActiveByUserId(db, order.userId);
    if (card) {
      log.info({ event: 'job.issue_card.reusing_active', orderId, cardId: card.id });
      const topup = await paypace.topupCard({
        cardId: card.providerCardId,
        amountUsdCents,
        requestId: `topup_${orderId}_${card.id}`,
      });
      ensureTopupCompleted(topup, orderId);
      await updateBalance(db, card.id, amountUsdCents, log);
      log.info({
        event: 'job.issue_card.topup_ok',
        cardId: card.id,
        balanceUsdCents: topup.balanceUsdCents,
      });
    } else {
      // 2. Активной карты нет — выпускаем НОВУЮ.
      // Recycled-карты между клиентами НЕ переиспользуем: `release` закрывает
      // карту в провайдере необратимо, а переиспользование PAN разными клиентами
      // недопустимо (утечка реквизитов прежнему владельцу). Reuse — только в
      // рамках одного клиента через активную карту выше.
      const created = await paypace.createCard({ amountUsdCents });
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

    // 4. Привязать card к order.
    if (card) {
      await setOrderCardId(db, orderId, card.id, log);
    }

    // 5. Завершаем fulfillment: in_fulfillment → completed (claim уже перевёл
    // заказ в in_fulfillment выше).
    await transitionOrder(db, {
      orderId,
      toStatus: 'completed',
      actorType: 'system',
      eventType: 'fulfillment_completed',
      payload: card ? { cardId: card.id, panMasked: card.panMasked } : null,
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

/**
 * Async-topup PaySpace может вернуть `pending` (деньги ещё не подтверждены) — в
 * этом случае НЕ завершаем заказ: бросаем, чтобы уйти в `failed` и отдать
 * оператору. Повтор безопасен: topup идемпотентен по `requestId`.
 */
function ensureTopupCompleted(
  topup: { status: string; requestId: string },
  orderId: string,
): void {
  if (topup.status !== 'completed') {
    throw new Error(
      `paypace topup не завершён (status=${topup.status}, requestId=${topup.requestId}, orderId=${orderId})`,
    );
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
    // chat_id строкой — Bot API это принимает, Number() терял бы точность на
    // больших telegram_id.
    await getBot().api.sendMessage(args.telegramId, message);
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
