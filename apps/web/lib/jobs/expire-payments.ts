import 'server-only';

import * as Sentry from '@sentry/nextjs';

import {
  claimPaymentTerminal,
  deleteExpiredLinkTokens,
  findExpiredPayableOrders,
  findPendingPaymentByOrderId,
  getDb,
  getOrderById,
  getServiceById,
  getUserTelegramId,
  transitionOrder,
  type OrderRow,
} from '@oplati/db';

import { childLogger } from '../logger.ts';
import { getBot } from '../telegram/bot.ts';
import { buildOrderExpiredMessage } from '../telegram/templates.ts';
import { pollPaymentOnce } from './poll-payment-one.ts';

/**
 * Cron `expire-payments` — каждые 15 минут. Находит заказы в pending_payment
 * с истёкшим `expires_at` → переводит в `expired` и отправляет пользователю
 * сообщение «срок оплаты истёк».
 */

const log = childLogger('cron.expire-payments');

/**
 * Статусы, из которых заказ ещё может быть оплачен, — те же, что выбирает
 * `findExpiredPayableOrders`. Нужны при перечитывании заказа перед claim'ом:
 * снапшот выборки к этому моменту может устареть.
 */
const PAYABLE_STATUSES: ReadonlySet<string> = new Set(['ready_for_payment', 'pending_payment']);

/**
 * Бюджет прогона на ВНЕШНИЕ сверки со шлюзом. Опрос идёт последовательно
 * (порядок nonce Freekassa), клиент шлюза ретраит GET с таймаутом 30 с — то
 * есть один недоступный шлюз стоит до полутора минут на заказ. Без бюджета
 * бэклог в `EXPIRE_BATCH_LIMIT=200` протухших заказов растянул бы прогон на
 * часы при `maxDuration=300`, прогоны наложились бы друг на друга, а попутная
 * чистка `link_tokens` в конце функции не выполнилась бы ни разу.
 *
 * Исчерпан бюджет — оставшиеся заказы С ПЛАТЕЖОМ не хоронятся (их статус не
 * подтверждён), но заказы без платежа (протухшие черновики) обрабатываются
 * дальше: им внешняя сверка не нужна.
 */
const POLL_BUDGET_MS = 60_000;

/**
 * Сколько держим заказ незахороненным, пока шлюз не подтвердил статус платежа.
 *
 * Без предела «шлюз не отвечает» = «заказ живёт в pending_payment вечно»: у
 * платежа может быть `provider_ref`, по которому шлюз стабильно отдаёт 404
 * (инвойс вычищен, ключ ротирован), и такой заказ навсегда занимал бы голову
 * очереди (`ORDER BY expires_at ASC LIMIT 200`) — накопив 200 штук, крон
 * перестал бы хоронить вообще что-либо, продолжая рапортовать успех.
 *
 * Сутки — с запасом: счёт живёт час, `poll-payment` опрашивает тот же платёж
 * каждые 5 минут, то есть к этому моменту сверка провалилась ~300 раз подряд.
 * Захоронение по истечении окна — не тихое: уходит Sentry-алёрт, и поздняя
 * оплата по failed-платежу всё равно пойдёт по ветке `paid_after_terminal` с
 * DM владельцу.
 */
const UNCONFIRMED_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Заказ всё ещё подлежит захоронению? Перечитанная строка, а не снапшот.
 *
 * Между выборкой и claim'ом проходит время (внешний вызов шлюза при финальной
 * сверке — единицы секунд), и за это окно конкурентный `confirm` мог выставить
 * новый счёт, продлив `expires_at`, либо заказ уже ушёл в `paid`. Захоронение
 * живого заказа означало бы «клиент видит ссылку оплаты, а заказ мёртв».
 */
function isStillExpirable(order: OrderRow): boolean {
  if (!PAYABLE_STATUSES.has(order.status)) return false;
  if (!order.expiresAt) return false;
  return order.expiresAt.getTime() <= Date.now();
}

export type ExpirePaymentsResult = {
  /** Сколько заказов РЕАЛЬНО похоронено этим прогоном. */
  expired: number;
  /** Сколько пропущено (оплата в процессе, статус не подтверждён, заказ ожил). */
  skipped: number;
  errors: number;
};

export async function expirePayments(): Promise<ExpirePaymentsResult> {
  log.info({ event: 'cron.expire_payments.start' });

  const db = getDb();
  const candidates = await findExpiredPayableOrders(db);

  log.info({ event: 'cron.expire_payments.found', count: candidates.length });

  let errors = 0;
  // Считаем ЗАХОРОНЕННЫЕ, а не размер выборки (находка ревью): с ветками
  // пропуска «expired = сколько выбрали» — систематически ложная цифра, и в
  // отказе «шлюз лёг, не похоронено ничего» крон рапортовал бы полный успех.
  let buried = 0;
  let skipped = 0;
  const pollDeadline = Date.now() + POLL_BUDGET_MS;

  for (const order of candidates) {
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
        // ФИНАЛЬНАЯ СВЕРКА СО ШЛЮЗОМ перед захоронением (аудит 2026-08-10, HIGH).
        // Захороненный платёж становится `failed`, а `findPendingPaymentsForPoll`
        // выбирает строго `pending` — то есть после захоронения его не опросит
        // НИКТО и НИКОГДА. Оплата на последних минутах жизни счёта плюс
        // потерянный вебхук давали ровно то, от чего страхует весь остальной
        // контур: деньги у провайдера, заказ `expired`, ноль алёртов.
        //
        // `applyTerminal: false` — терминальные статусы шлюза обрабатываем СВОИМ
        // путём ниже: он не только переводит заказ, но и шлёт клиенту «срок
        // оплаты истёк». Дай мы это сделать обработчикам поллера, заказ ушёл бы
        // в `expired`/`cancelled` молча, из-под нас, и клиент не узнал бы ничего.
        //
        // Бюджет исчерпан — шлюз не зовём и заказ не хороним: мы его статус не
        // спрашивали, а хоронить неспрошенный платёж — ровно тот отказ, от
        // которого эта сверка и защищает. Заказ подождёт следующего прогона.
        if (Date.now() >= pollDeadline) {
          skipped++;
          log.warn({
            event: 'cron.expire_payments.poll_budget_exhausted',
            orderId: order.id,
            paymentId: pendingPayment.id,
          });
          continue;
        }

        const outcome = await pollPaymentOnce(pendingPayment, { applyTerminal: false });

        if (outcome === 'recovered') {
          // Оплата найдена и проведена — заказ уже `paid`, хоронить нечего.
          skipped++;
          log.info({
            event: 'cron.expire_payments.poll_recovered_payment',
            orderId: order.id,
            paymentId: pendingPayment.id,
          });
          continue;
        }

        if (outcome === 'error') {
          // Статус НЕИЗВЕСТЕН. Обычно ждём следующего прогона, но не вечно:
          // после `UNCONFIRMED_GRACE_MS` хороним с алёртом, иначе такие заказы
          // навсегда занимают голову очереди и блокируют весь крон.
          const unconfirmedForMs = order.expiresAt
            ? Date.now() - order.expiresAt.getTime()
            : Number.POSITIVE_INFINITY;
          if (unconfirmedForMs < UNCONFIRMED_GRACE_MS) {
            skipped++;
            log.warn({
              event: 'cron.expire_payments.poll_unconfirmed',
              orderId: order.id,
              paymentId: pendingPayment.id,
              unconfirmedForMs,
            });
            continue;
          }
          log.error({
            event: 'cron.expire_payments.burying_unconfirmed',
            orderId: order.id,
            paymentId: pendingPayment.id,
            unconfirmedForMs,
          });
          Sentry.captureMessage('Заказ похоронен без подтверждения шлюза — сверка не отвечает сутки', {
            level: 'error',
            tags: { source: 'cron.expire-payments', alert: 'burying_unconfirmed' },
            extra: { orderId: order.id, paymentId: pendingPayment.id, unconfirmedForMs },
          });
        }
      }

      // Перечитываем заказ ПЕРЕД claim'ом: снапшот выборки мог устареть, пока
      // шёл внешний вызов шлюза (конкурентный confirm продлевает `expires_at`).
      const fresh = await getOrderById(db, order.id);
      if (!fresh || !isStillExpirable(fresh)) {
        skipped++;
        log.info({
          event: 'cron.expire_payments.revalidated_skip',
          orderId: order.id,
          status: fresh?.status ?? null,
        });
        continue;
      }

      if (pendingPayment) {
        const claimed = await claimPaymentTerminal(db, pendingPayment.id, log);
        if (!claimed) {
          skipped++;
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
      // Считаем ПОСЛЕ успешного перехода: сбой на нём уходит в `errors`, и
      // заказ похороненным не считается.
      buried++;

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

  log.info({
    event: 'cron.expire_payments.done',
    candidates: candidates.length,
    expired: buried,
    skipped,
    errors,
  });
  return { expired: buried, skipped, errors };
}
