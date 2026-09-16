import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentTerminal,
  findPaymentsByOrderId,
  findPendingPaymentByOrderId,
  findRedemptionByOrderId,
  getDb,
  getOrderById,
  lockOrderForUpdate,
  transitionOrder,
} from '@oplati/db';
import { FREEKASSA_ORDER_STATUS, OrderTransitionError, type OrderStatus } from '@oplati/types';

import { childLogger } from '../logger.ts';
import { pollPaymentOnce } from '../jobs/poll-payment-one.ts';
import { isPayableStatus } from '../cabinet/types.ts';

/**
 * Отмена заказа клиентом — ЕДИНСТВЕННАЯ точка на все каналы (Mini App, кнопка
 * бота). Отдельным модулем, а не методом кабинета: у бота своя кнопка
 * «Отменить», и своя копия там означала бы копию всех гейтов ниже — а забытый
 * гейт здесь стоит денег.
 *
 * Отменяем оба оплатимых статуса, включая `pending_payment` (решение владельца
 * 2026-09-07): счёт живёт час, и заказ, который клиент решил не платить, всё
 * это время держит карточный фонд и висит в «Ждут оплаты».
 *
 * Порядок шагов продиктован разбором ревью 2026-09-07:
 *
 *  1. **Сверка со шлюзом ДО захоронения счёта.** `poll-payment` выбирает строго
 *     `pending` и не смотрит платежи моложе 10 минут, а захороненный (`failed`)
 *     не опрашивает уже никогда. Без сверки «оплатил → вернулся через две
 *     минуты → отменил» при потерянном уведомлении означало бы принятые деньги,
 *     мёртвый заказ и НОЛЬ алёртов: ветка `paid_after_terminal` спасает только
 *     при доставленном вебхуке. Тот же приём — в `expire-payments`.
 *  2. **Лок заказа первым действием транзакции + перечитывание платежа под
 *     ним.** Снапшот, снятый до транзакции, устаревает: между «живого счёта
 *     нет» и переходом конкурентный `payments/create` коммитит счёт вместе с
 *     `ready_for_payment → pending_payment`, и отмена уносила бы заказ в
 *     `cancelled`, оставив живой незаклеймённый платёж.
 *  3. **Платёж хоронится ПЕРЕД заказом и в той же транзакции.** Наоборот —
 *     окно, где заказ уже `cancelled`, а платёж ещё `pending`: пришедший
 *     вебхук клеймит оплату и упирается в запрещённый `cancelled → paid`.
 *     Сорванный переход откатывает claim, и счёт остаётся живым.
 *
 * Остаточный риск: счёт у шлюза наша отмена не закрывает (API отмены инвойса
 * нет ни у Freekassa, ни у L&P), ссылка живёт до конца своего TTL. Поэтому
 * тексты клиенту не обещают «счёт закрыт», а прямо просят не платить по старой
 * ссылке; оплата по захороненному счёту идёт веткой `paid_after_terminal`
 * (Sentry + ops-группа «нужен ручной возврат»).
 */

const log = childLogger('orders.cancel');
const dbLog = childLogger('db');

export type CancelOrderSource = 'cabinet' | 'telegram_inline_button';

export type CancelOrderResult =
  | { ok: true; invoiceClosed: boolean; message: string }
  | {
      ok: false;
      error: 'not_found' | 'not_cancellable' | 'payment_in_progress' | 'verification_failed' | 'failed';
      message: string;
    };

/**
 * Сколько ждём ответа шлюза на сверке перед отменой.
 *
 * Своё окно, а не таймаут клиента провайдера: у него ретраи и до полутора
 * минут на попытку, а здесь человек смотрит на кнопку, и роут живёт 60 секунд.
 * Не уложились — отказываем (см. `verification_failed`), а не хороним счёт
 * неспрошенным.
 */
const VERIFY_DEADLINE_MS = 12_000;

/**
 * Текст отказа по ФАКТИЧЕСКОМУ статусу заказа: «этот заказ уже нельзя
 * отменить» одинаково описывает оплаченный заказ, протухший и отменённый
 * секунду назад из второй вкладки — а действия клиента после этого разные.
 */
export function notCancellableText(status: OrderStatus): string {
  switch (status) {
    case 'cancelled':
      return 'Заказ уже отменён.';
    case 'expired':
      return 'Срок заказа истёк — он закрылся сам.';
    case 'payment_review':
      return 'Банк проверяет платёж по этому заказу — дождись решения, отменить сейчас нельзя.';
    case 'paid':
    case 'in_fulfillment':
    case 'completed':
      return 'Заказ уже оплачен — отменить его нельзя. Если что-то пошло не так, напиши в поддержку.';
    default:
      return 'Этот заказ уже нельзя отменить.';
  }
}

const PAYMENT_IN_PROGRESS_TEXT =
  'Оплата по этому заказу сейчас обрабатывается — отменять его нельзя. Обнови экран через минуту.';
const PAYMENT_DONE_TEXT = 'Оплата по заказу прошла — отменять уже нечего. Открой заказ заново.';
const HOLD_TEXT =
  'Банк проверяет платёж по этому заказу — отменить его сейчас нельзя. Напишем, как только будет решение.';
const VERIFICATION_FAILED_TEXT =
  'Не получилось проверить, не оплачен ли счёт, — отменять вслепую нельзя. Попробуй через пару минут; если не оплатишь, заказ закроется сам.';

/**
 * Ждём результат сверки не дольше своего окна. Промис шлюза не бросает
 * (`pollPaymentOnce` ловит всё сам), но подстраховка от rejection здесь есть:
 * незамеченный отказ в фоне стал бы unhandled rejection процесса.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, onDeadline: T): Promise<T> {
  return await new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onDeadline), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log.warn({ event: 'orders.cancel.verify_rejected', err });
        resolve(onDeadline);
      },
    );
  });
}

export async function cancelOrderByClient(input: {
  userId: string;
  orderId: string;
  source: CancelOrderSource;
}): Promise<CancelOrderResult> {
  const { userId, orderId, source } = input;
  const db = getDb();

  const order = await getOrderById(db, orderId);
  if (!order || order.userId !== userId) {
    // Чужой заказ отдаём как несуществующий (не раскрываем чужие id), но
    // ЛОГИРУЕМ: `orderId` приходит из callback_data/тела запроса и подделываем,
    // поток таких попыток — сигнал, а не шум.
    if (order && order.userId !== userId) {
      log.warn({ event: 'orders.cancel.ownership_mismatch', orderId, source });
      Sentry.captureMessage('cancel order: ownership mismatch', {
        level: 'warning',
        tags: { source: 'orders.cancel' },
        extra: { orderId, channel: source },
      });
    }
    return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
  }
  if (!isPayableStatus(order.status)) {
    return { ok: false, error: 'not_cancellable', message: notCancellableText(order.status) };
  }

  // Успешный платёж при заказе, ещё не доехавшем до `paid`, — рассинхрон
  // (вебхук в процессе, сорвался переход). Деньги приняты: отмена превратила
  // бы это в оплаченный, но отменённый заказ. Тот же барьер, что
  // `NOT EXISTS (succeeded)` у выборки протухших заказов.
  const existingPayments = await findPaymentsByOrderId(db, orderId);
  if (existingPayments.some((p) => p.status === 'succeeded')) {
    log.warn({ event: 'orders.cancel.succeeded_payment_present', orderId, status: order.status });
    return { ok: false, error: 'payment_in_progress', message: PAYMENT_DONE_TEXT };
  }

  const snapshotPending = await findPendingPaymentByOrderId(db, orderId);
  if (snapshotPending) {
    // Холд банка: деньги списаны и лежат на проверке. Захоронить такой платёж
    // значит потерять из виду его разрешение — `poll-payment` к `failed` не
    // возвращается, а экран «Проверка платежей» отменённые заказы не тянет.
    if (snapshotPending.lastProviderStatus === FREEKASSA_ORDER_STATUS.ANTIFRAUD_HOLD) {
      log.info({ event: 'orders.cancel.hold_blocks', orderId, paymentId: snapshotPending.id });
      return { ok: false, error: 'not_cancellable', message: HOLD_TEXT };
    }

    const outcome = await withDeadline(
      pollPaymentOnce(snapshotPending, { applyTerminal: false }),
      VERIFY_DEADLINE_MS,
      'error' as const,
    );
    if (outcome === 'recovered') {
      // Оплата нашлась и проведена: заказ уже `paid`, отменять нечего.
      log.info({ event: 'orders.cancel.verify_recovered', orderId, paymentId: snapshotPending.id });
      return { ok: false, error: 'payment_in_progress', message: PAYMENT_DONE_TEXT };
    }
    if (outcome === 'error') {
      // Статус НЕИЗВЕСТЕН — fail-closed. Заказ жив и закроется сам по сроку;
      // хоронить неспрошенный счёт нельзя, к нему уже никто не вернётся.
      log.warn({ event: 'orders.cancel.verify_failed', orderId, paymentId: snapshotPending.id });
      return { ok: false, error: 'verification_failed', message: VERIFICATION_FAILED_TEXT };
    }
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // Лок ПЕРВЫМ действием: конкурентный `payments/create` встанет на своём
      // переходе заказа, и его платёж мы либо увидим ниже, либо его ещё нет.
      const locked = await lockOrderForUpdate(tx, orderId);
      if (!locked) return { kind: 'gone' as const };
      // Статус мог смениться, пока мы ходили к шлюзу: холд уводит заказ в
      // `payment_review` (оттуда отмена запрещена нашим гейтом, хотя машина
      // переход разрешает), крон — в `expired`.
      if (!isPayableStatus(locked.status)) {
        return { kind: 'not_cancellable' as const, status: locked.status };
      }

      const pending = await findPendingPaymentByOrderId(tx, orderId);
      if (pending) {
        const claimed = await claimPaymentTerminal(tx, pending.id, dbLog);
        // Платёж увели: вебхук (оплата) или крон (захоронение). Кто именно —
        // разбираем после транзакции, перечитав строку.
        if (!claimed) return { kind: 'payment_claimed_elsewhere' as const };
      }

      await transitionOrder(tx, {
        orderId,
        toStatus: 'cancelled',
        actorType: 'user',
        actorId: userId,
        eventType: 'user_cancelled',
        payload: {
          source,
          fromStatus: locked.status,
          ...(pending ? { paymentId: pending.id } : {}),
        },
      });
      // Списание баллов ОТДЕЛЬНО не снимаем: резерв под заказом в `cancelled`
      // перестаёт вычитаться из баланса ПРАВИЛОМ (`balanceExpr`). Читаем его
      // здесь только ради текста — молчаливый возврат клиент прочтёт как
      // «баллы сгорели» и придёт в поддержку.
      const redemption = await findRedemptionByOrderId(tx, orderId);
      return {
        kind: 'cancelled' as const,
        invoiceClosed: pending !== null,
        bonusReturnedKopecks:
          redemption && redemption.status === 'reserved' ? redemption.discountKopecks : 0,
      };
    });

    if (outcome.kind === 'gone') {
      return { ok: false, error: 'not_found', message: 'Заказ не найден.' };
    }
    if (outcome.kind === 'not_cancellable') {
      return { ok: false, error: 'not_cancellable', message: notCancellableText(outcome.status) };
    }
    if (outcome.kind === 'payment_claimed_elsewhere') {
      const fresh = await findPaymentsByOrderId(db, orderId);
      const paid = fresh.some((p) => p.status === 'succeeded');
      log.info({ event: 'orders.cancel.payment_claimed_elsewhere', orderId, paid });
      return {
        ok: false,
        error: 'payment_in_progress',
        message: paid ? PAYMENT_DONE_TEXT : PAYMENT_IN_PROGRESS_TEXT,
      };
    }

    log.info({
      event: 'orders.cancel.done',
      orderId,
      source,
      fromStatus: order.status,
      invoiceClosed: outcome.invoiceClosed,
    });
    return {
      ok: true,
      invoiceClosed: outcome.invoiceClosed,
      // ⚠️ «Счёт закрыт» не обещаем: у шлюза он живёт до конца своего срока, и
      // оплата по старой ссылке придёт на уже захороненный платёж.
      message:
        (outcome.invoiceClosed
          ? 'Заказ отменён. По старой ссылке больше не плати — заказ уже закрыт. Оформить новый можно в любой момент.'
          : 'Заказ отменён. Оформить новый можно в любой момент.') +
        (outcome.bonusReturnedKopecks > 0
          ? ` Баллы вернулись на баланс: ${Math.round(outcome.bonusReturnedKopecks / 100)} ₽. Списать их можно на следующем заказе.`
          : ''),
    };
  } catch (err) {
    // Заказ ушёл в другой статус между локом и переходом — теоретически
    // недостижимо под локом, но матрица переходов главнее наших ожиданий.
    if (err instanceof OrderTransitionError) {
      log.info({ event: 'orders.cancel.transition_race', orderId, from: err.from });
      return { ok: false, error: 'not_cancellable', message: notCancellableText(err.from) };
    }
    log.error({ event: 'orders.cancel.failed', orderId, source, err });
    Sentry.captureException(err, { tags: { source: 'orders.cancel' }, extra: { orderId } });
    return {
      ok: false,
      error: 'failed',
      message: 'Не получилось отменить заказ. Попробуй ещё раз через минуту.',
    };
  }
}
